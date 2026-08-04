import { describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterServerRoute,
} from "./contracts";
import { executeKernelRequest } from "./execute";
import { compileRoutes } from "./routeCompiler";

const route = (
  options: Partial<HotUpdaterServerRoute> = {},
): HotUpdaterServerRoute => ({
  access: { kind: "public" },
  id: "route",
  method: "POST",
  path: "/route",
  async handle() {
    return new Response("handled");
  },
  ...options,
});

const authenticatedProvider = (): HotUpdaterAuthenticationProvider => ({
  id: "authentication",
  async authenticate() {
    return {
      kind: "authenticated",
      principal: { issuer: "issuer", subject: "subject" },
    };
  },
});

describe("executeKernelRequest", () => {
  it("denies a protected request before reading its body or calling its handler", async () => {
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pull();
          controller.enqueue(new Uint8Array([1]));
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("https://example.com/api/route", {
      body,
      duplex: "half",
      method: "POST",
    });
    const handle = vi.fn(async () => new Response("leaked"));
    const router = compileRoutes([
      route({ access: { kind: "protected" }, handle }),
    ]);
    const authentication: HotUpdaterAuthenticationProvider = {
      id: "authentication",
      async authenticate() {
        return { kind: "anonymous" };
      },
    };

    const response = await executeKernelRequest({
      authentication,
      basePath: "/api",
      request,
      router,
    });

    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(pull).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it("overwrites caching on every protected response", async () => {
    const router = compileRoutes([
      route({
        access: { kind: "protected" },
        method: "GET",
        async handle() {
          return new Response("handled", {
            headers: { "cache-control": "public, max-age=60" },
          });
        },
      }),
    ]);

    const response = await executeKernelRequest({
      authentication: authenticatedProvider(),
      basePath: "/api",
      request: new Request("https://example.com/api/route"),
      router,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("authenticates before parsing a protected request", async () => {
    const order: string[] = [];
    const router = compileRoutes([
      route({
        access: { kind: "protected" },
        input: {
          async parse(request) {
            order.push(`parse:${await request.text()}`);
            return "parsed";
          },
        },
        async handle(_context, input) {
          order.push(`handle:${input}`);
          return new Response("handled");
        },
      }),
    ]);
    const authentication: HotUpdaterAuthenticationProvider = {
      id: "authentication",
      async authenticate() {
        order.push("authenticate");
        return {
          kind: "authenticated",
          principal: { issuer: "issuer", subject: "subject" },
        };
      },
    };

    const response = await executeKernelRequest({
      authentication,
      basePath: "/api",
      request: new Request("https://example.com/api/route", {
        body: "body",
        method: "POST",
      }),
      router,
    });

    expect(response.status).toBe(200);
    expect(order).toEqual(["authenticate", "parse:body", "handle:parsed"]);
  });

  it("preserves successful public response headers", async () => {
    const router = compileRoutes([
      route({
        method: "GET",
        async handle() {
          return new Response("handled", {
            headers: { "cache-control": "public, max-age=60" },
          });
        },
      }),
    ]);

    const response = await executeKernelRequest({
      authentication: {
        id: "must-not-run",
        async authenticate() {
          throw new Error("unexpected authentication");
        },
      },
      basePath: "/api",
      request: new Request("https://example.com/route"),
      router,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("returns non-cacheable opaque kernel 404 and 500 responses", async () => {
    const secret = "handler secret";
    const router = compileRoutes([
      route({
        async handle() {
          throw new Error(secret);
        },
      }),
    ]);

    const missing = await executeKernelRequest({
      basePath: "/api",
      request: new Request("https://example.com/api/missing"),
      router,
    });
    const failed = await executeKernelRequest({
      basePath: "/api",
      request: new Request("https://example.com/api/route", {
        method: "POST",
      }),
      router,
    });

    expect(missing.status).toBe(404);
    expect(failed.status).toBe(500);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
    expect(await failed.text()).not.toContain(secret);
  });
});
