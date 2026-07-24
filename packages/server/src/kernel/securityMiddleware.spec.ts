import { describe, expect, it, vi } from "vitest";

import { authenticateMatchedRoute } from "./authentication";
import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterMatchedRoute,
  HotUpdaterPostAuthMiddleware,
  HotUpdaterRequestExecutionContext,
  HotUpdaterServerRoute,
} from "./contracts";
import { executeKernelRequest } from "./execute";
import {
  compilePostAuthMiddleware,
  executePostAuthMiddleware,
} from "./middlewareDag";
import { compileRoutes } from "./routeCompiler";

const SECRET = "must-not-appear-4f079c";
const matchedRoute: HotUpdaterMatchedRoute = {
  access: { kind: "protected" },
  id: "protected",
  method: "POST",
  params: {},
  pattern: "/protected",
};

const authenticatedProvider = (): HotUpdaterAuthenticationProvider => ({
  id: "auth",
  async authenticate() {
    return {
      kind: "authenticated",
      principal: { issuer: "issuer", subject: "subject" },
    };
  },
});

const route = (
  options: Partial<HotUpdaterServerRoute<undefined>> = {},
): HotUpdaterServerRoute<undefined> => ({
  access: { kind: "protected" },
  id: "protected",
  method: "POST",
  path: "/protected",
  async handle() {
    return new Response(null, { status: 204 });
  },
  ...options,
});

describe("security conformance: post-auth middleware", () => {
  it("short-circuits after auth without parsing or handler work", async () => {
    // Given
    const parse = vi.fn(async () => undefined);
    const handle = vi.fn(async () => new Response(SECRET));
    const router = compileRoutes([route({ handle, input: { parse } })]);

    // When
    const response = await executeKernelRequest({
      authentication: authenticatedProvider(),
      basePath: "/api",
      middleware: [
        {
          id: "short-circuit",
          phase: "post-auth",
          async handle() {
            return new Response(null, { status: 204 });
          },
        },
      ],
      request: new Request("https://example.com/api/protected", {
        method: "POST",
      }),
      router,
    });

    // Then
    expect(response.status).toBe(204);
    expect(parse).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it("obeys DAG order, reverse unwind, and race-safe next-once", async () => {
    // Given
    const trace: string[] = [];
    const item = (
      id: string,
      after?: readonly string[],
    ): HotUpdaterPostAuthMiddleware => ({
      after,
      id,
      phase: "post-auth",
      async handle(_context, next) {
        trace.push(`${id}:enter`);
        const response = await next();
        trace.push(`${id}:exit`);
        return response;
      },
    });
    const ordered = compilePostAuthMiddleware([
      item("second", ["first"]),
      item("first"),
    ]);
    const handler = vi.fn(async () => {
      trace.push("handler");
      return new Response(SECRET);
    });
    const invalid: HotUpdaterPostAuthMiddleware = {
      id: "invalid",
      phase: "post-auth",
      async handle(_context, next) {
        await Promise.all([next(), next()]);
        return new Response(SECRET);
      },
    };
    const protectedContext: HotUpdaterRequestExecutionContext = {
      principal: { issuer: "issuer", subject: "subject" },
      route: {
        ...matchedRoute,
        access: { kind: "protected" },
      },
    };
    const context = (
      await authenticateMatchedRoute({
        headers: new Headers(),
        provider: authenticatedProvider(),
        route: matchedRoute,
        signal: new AbortController().signal,
        url: new URL("https://example.com/protected"),
      })
    ).kind;

    // When
    const unwound = await executePostAuthMiddleware({
      context: protectedContext,
      handler,
      middleware: ordered,
    });
    const reused = await executePostAuthMiddleware({
      context: protectedContext,
      handler,
      middleware: [invalid],
    });

    // Then
    expect(context).toBe("authenticated");
    expect(unwound.status).toBe(200);
    expect(trace).toEqual([
      "first:enter",
      "second:enter",
      "handler",
      "second:exit",
      "first:exit",
      "handler",
    ]);
    expect(reused.status).toBe(500);
    expect(await reused.text()).not.toContain(SECRET);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
