import { describe, expect, it, vi } from "vitest";

import {
  authenticateMatchedRoute,
  type AuthenticationDecision,
} from "./authentication";
import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterMatchedRoute,
  HotUpdaterServerRoute,
} from "./contracts";
import { executeKernelRequest } from "./execute";
import { compileRoutes } from "./routeCompiler";

const matchedRoute: HotUpdaterMatchedRoute = {
  access: { kind: "protected" },
  id: "protected",
  method: "POST",
  params: {},
  pattern: "/protected",
};

const provider = (
  authenticate: () => Promise<unknown>,
): HotUpdaterAuthenticationProvider => {
  const value: HotUpdaterAuthenticationProvider = {
    id: "auth",
    async authenticate() {
      return { kind: "anonymous" };
    },
  };
  Reflect.set(value, "authenticate", vi.fn(authenticate));
  return value;
};

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

describe("security conformance: principal isolation", () => {
  const authenticate = (principal: unknown): Promise<AuthenticationDecision> =>
    authenticateMatchedRoute({
      headers: new Headers(),
      provider: provider(async () => ({ kind: "authenticated", principal })),
      route: matchedRoute,
      signal: new AbortController().signal,
      url: new URL("https://example.com/protected"),
    });

  it("enforces Unicode validity and UTF-8 byte boundaries", async () => {
    // Given
    const valid = {
      issuer: "😀".repeat(512),
      subject: "é".repeat(512),
    };
    const invalid = [
      { ...valid, subject: `${valid.subject}é` },
      { ...valid, issuer: `${valid.issuer}😀` },
      { issuer: "issuer", subject: "\ud800" },
      { issuer: "issuer", subject: " subject" },
      { issuer: "issuer", subject: "subject\u007f" },
    ];

    // When
    const [accepted, ...rejected] = await Promise.all([
      authenticate(valid),
      ...invalid.map(authenticate),
    ]);

    // Then
    expect(accepted.kind).toBe("authenticated");
    if (accepted.kind === "authenticated") {
      expect(accepted.context.principal).not.toBe(valid);
      expect(Object.isFrozen(accepted.context.principal)).toBe(true);
    }
    expect(
      rejected.every(
        (result) =>
          result.kind === "response" && result.response.status === 500,
      ),
    ).toBe(true);
  });

  it("isolates frozen principals across concurrent requests", async () => {
    // Given
    const entered: Array<{
      readonly frozen: boolean;
      readonly principal: object;
      readonly subject: string;
    }> = [];
    let arrivals = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authentication = provider(async function authenticateRequest() {
      throw new Error("replaced below");
    });
    Reflect.set(
      authentication,
      "authenticate",
      async (input: { headers: Headers }) => ({
        kind: "authenticated",
        principal: {
          issuer: "issuer",
          subject: input.headers.get("x-principal"),
        },
      }),
    );
    const router = compileRoutes([
      route({
        async handle(context) {
          if (
            context.route.access.kind !== "protected" ||
            context.principal === undefined
          ) {
            throw new Error("protected principal required");
          }
          const principal = context.principal;
          entered.push({
            frozen: Object.isFrozen(principal),
            principal,
            subject: principal.subject,
          });
          arrivals += 1;
          if (arrivals === 2) release?.();
          await barrier;
          expect(context.principal.subject).toBe(principal.subject);
          return new Response(null, { status: 204 });
        },
      }),
    ]);

    // When
    const responses = await Promise.all(
      ["alpha", "bravo"].map((subject) =>
        executeKernelRequest({
          authentication,
          basePath: "/api",
          middleware: [],
          request: new Request("https://example.com/api/protected", {
            headers: { "x-principal": subject },
            method: "POST",
          }),
          router,
        }),
      ),
    );

    // Then
    expect(responses.map(({ status }) => status)).toEqual([204, 204]);
    expect(entered.map(({ subject }) => subject).sort()).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(entered.every(({ frozen }) => frozen)).toBe(true);
    expect(entered[0]?.principal).not.toBe(entered[1]?.principal);
  });
});
