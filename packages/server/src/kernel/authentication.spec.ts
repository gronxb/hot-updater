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
  const auth: HotUpdaterAuthenticationProvider = {
    id: "auth",
    async authenticate() {
      return { kind: "anonymous" };
    },
  };
  Reflect.set(
    auth,
    "authenticate",
    vi.fn(async () => result),
  );
  return auth;
};

describe("selectAuthenticationProvider", () => {
  it("rejects missing protected and multiple authentication providers", () => {
    // Given / When / Then
    expect(() =>
      selectAuthenticationProvider({
        providers: [],
        routes: [matchedRoute("protected")],
      }),
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
        routes: [matchedRoute("public")],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MULTIPLE_AUTHENTICATION_PROVIDERS",
      }),
    );
  });
});

describe("authenticateMatchedRoute", () => {
  it("skips authentication for public routes", async () => {
    // Given
    const auth = provider({ kind: "authenticated" });

    // When
    const result = await authenticateMatchedRoute({
      headers: new Headers(),
      provider: auth,
      route: matchedRoute("public"),
      signal: new AbortController().signal,
      url: new URL("https://example.com/resource"),
    });

    // Then
    expect(result.kind).toBe("authenticated");
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "anonymous" }, 401],
    [{ kind: "unavailable" }, 503],
    [{ kind: "forged" }, 500],
  ])(
    "maps provider result %# to an opaque status",
    async (authResult, status) => {
      // Given
      const auth = provider(authResult);

      // When
      const result = await authenticateMatchedRoute({
        headers: new Headers({ Authorization: "secret" }),
        provider: auth,
        route: matchedRoute("protected"),
        signal: new AbortController().signal,
        url: new URL("https://example.com/resource"),
      });

      // Then
      expect(result.kind).toBe("response");
      if (result.kind === "response") {
        expect(result.response.status).toBe(status);
        expect(await result.response.text()).not.toContain("secret");
      }
    },
  );

  it("copies and freezes an exact valid principal", async () => {
    // Given
    const source = { issuer: "issuer", subject: "subject" };
    const headers = new Headers({ Authorization: "secret" });
    const url = new URL("https://example.com/resource");
    const auth: HotUpdaterAuthenticationProvider = {
      id: "auth",
      async authenticate(input) {
        input.headers.set("Authorization", "mutated");
        input.url.pathname = "/mutated";
        return { kind: "authenticated", principal: source };
      },
    };

    // When
    const result = await authenticateMatchedRoute({
      headers,
      provider: auth,
      route: matchedRoute("protected"),
      signal: new AbortController().signal,
      url,
    });
    source.subject = "changed";

    // Then
    expect(result.kind).toBe("authenticated");
    if (result.kind === "authenticated") {
      expect(result.context.principal).toEqual({
        issuer: "issuer",
        subject: "subject",
      });
      expect(Object.isFrozen(result.context.principal)).toBe(true);
    }
    expect(headers.get("Authorization")).toBe("secret");
    expect(url.pathname).toBe("/resource");
  });

  it("rejects invalid principal strings before creating a context", async () => {
    // Given
    const extraSymbol = { issuer: "issuer", subject: "subject" };
    Reflect.set(extraSymbol, Symbol("secret"), "secret");
    const invalidPrincipals = [
      { issuer: "issuer", subject: " padded " },
      { issuer: "issuer\u0000", subject: "subject" },
      { issuer: "issuer", subject: "x".repeat(1_025) },
      extraSymbol,
    ];

    // When
    const results = await Promise.all(
      invalidPrincipals.map((principal) =>
        authenticateMatchedRoute({
          headers: new Headers(),
          provider: provider({ kind: "authenticated", principal }),
          route: matchedRoute("protected"),
          signal: new AbortController().signal,
          url: new URL("https://example.com/resource"),
        }),
      ),
    );

    // Then
    expect(results.every((result) => result.kind === "response")).toBe(true);
    expect(
      results.every(
        (result) =>
          result.kind === "response" && result.response.status === 500,
      ),
    ).toBe(true);
  });

  it("preserves the authentication provider receiver", async () => {
    // Given
    const source: HotUpdaterAuthenticationProvider & {
      readonly marker: string;
    } = {
      id: "auth",
      marker: "original",
      async authenticate() {
        if (this.marker !== "original") throw new Error("wrong receiver");
        return {
          kind: "authenticated",
          principal: { issuer: "issuer", subject: "subject" },
        };
      },
    };
    const selected = selectAuthenticationProvider({
      providers: [source],
      routes: [matchedRoute("protected")],
    });

    // When
    const result = await authenticateMatchedRoute({
      headers: new Headers(),
      provider: selected,
      route: matchedRoute("protected"),
      signal: new AbortController().signal,
      url: new URL("https://example.com/resource"),
    });

    // Then
    expect(result.kind).toBe("authenticated");
  });
});
