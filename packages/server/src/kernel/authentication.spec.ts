import { describe, expect, it, vi } from "vitest";

import {
  authenticateMatchedRoute,
  selectAuthenticationProvider,
} from "./authentication";
import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterMatchedRoute,
} from "./contracts";

const matchedRoute = (
  access: "protected" | "public",
): HotUpdaterMatchedRoute => ({
  access: { kind: access },
  id: `route.${access}`,
  method: "POST",
  params: {},
  pattern: "/resource",
});

const provider = (result: unknown): HotUpdaterAuthenticationProvider => {
  const authentication: HotUpdaterAuthenticationProvider = {
    id: "authentication",
    async authenticate() {
      return { kind: "anonymous" };
    },
  };
  Reflect.set(
    authentication,
    "authenticate",
    vi.fn(async () => result),
  );
  return authentication;
};

describe("selectAuthenticationProvider", () => {
  it("requires exactly one provider when protected routes exist", () => {
    const protectedRoute = matchedRoute("protected");

    expect(() =>
      selectAuthenticationProvider({ providers: [], routes: [protectedRoute] }),
    ).toThrowError(
      expect.objectContaining({
        code: "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
      }),
    );
    expect(() =>
      selectAuthenticationProvider({
        providers: [
          provider({ kind: "anonymous" }),
          provider({ kind: "anonymous" }),
        ],
        routes: [protectedRoute],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "MULTIPLE_AUTHENTICATION_PROVIDERS" }),
    );
  });
});

describe("authenticateMatchedRoute", () => {
  it("bypasses the provider for public routes", async () => {
    const authentication = provider({ kind: "authenticated" });

    const decision = await authenticateMatchedRoute({
      headers: new Headers(),
      provider: authentication,
      route: matchedRoute("public"),
      signal: new AbortController().signal,
      url: new URL("https://example.com/resource"),
    });

    expect(decision.kind).toBe("authenticated");
    expect(authentication.authenticate).not.toHaveBeenCalled();
  });

  it("passes only defensive request metadata to the provider", async () => {
    const headers = new Headers({ authorization: "secret" });
    const url = new URL("https://example.com/resource");
    const authentication: HotUpdaterAuthenticationProvider = {
      id: "authentication",
      async authenticate(input) {
        expect(Object.keys(input).sort()).toEqual([
          "headers",
          "method",
          "route",
          "signal",
          "url",
        ]);
        input.headers.set("authorization", "mutated");
        input.url.pathname = "/mutated";
        expect(Object.isFrozen(input.route)).toBe(true);
        expect(Object.isFrozen(input.route.params)).toBe(true);
        return {
          kind: "authenticated",
          principal: { issuer: "issuer", subject: "subject" },
        };
      },
    };

    const decision = await authenticateMatchedRoute({
      headers,
      provider: authentication,
      route: matchedRoute("protected"),
      signal: new AbortController().signal,
      url,
    });

    expect(decision.kind).toBe("authenticated");
    expect(headers.get("authorization")).toBe("secret");
    expect(url.pathname).toBe("/resource");
    if (decision.kind === "authenticated") {
      expect(decision.context.principal).toEqual({
        issuer: "issuer",
        subject: "subject",
      });
      expect(Object.isFrozen(decision.context.principal)).toBe(true);
    }
  });

  it.each([
    [{ kind: "anonymous" }, 401],
    [{ kind: "unavailable" }, 503],
    [{ kind: "malformed", detail: "secret" }, 500],
  ])(
    "maps provider result %# to an opaque non-cacheable response",
    async (result, status) => {
      const decision = await authenticateMatchedRoute({
        headers: new Headers({ authorization: "secret" }),
        provider: provider(result),
        route: matchedRoute("protected"),
        signal: new AbortController().signal,
        url: new URL("https://example.com/resource"),
      });

      expect(decision.kind).toBe("response");
      if (decision.kind === "response") {
        expect(decision.response.status).toBe(status);
        expect(decision.response.headers.get("cache-control")).toBe(
          "private, no-store",
        );
        expect(await decision.response.text()).not.toContain("secret");
      }
    },
  );

  it("maps thrown providers and malformed principals to opaque 500 responses", async () => {
    const throwing: HotUpdaterAuthenticationProvider = {
      id: "authentication",
      async authenticate() {
        throw new Error("provider secret");
      },
    };
    const malformed = provider({
      kind: "authenticated",
      principal: { issuer: "issuer", subject: " padded " },
    });

    const decisions = await Promise.all(
      [throwing, malformed].map((authentication) =>
        authenticateMatchedRoute({
          headers: new Headers(),
          provider: authentication,
          route: matchedRoute("protected"),
          signal: new AbortController().signal,
          url: new URL("https://example.com/resource"),
        }),
      ),
    );

    expect(
      decisions.every(
        (decision) =>
          decision.kind === "response" && decision.response.status === 500,
      ),
    ).toBe(true);
  });
});
