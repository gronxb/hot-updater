import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { betterAuthPlugin, type BetterAuthConfiguredInstance } from "./index";

const authenticationInput = () => ({
  headers: new Headers({ authorization: "Bearer opaque" }),
  method: "POST" as const,
  route: {
    access: { kind: "protected" as const },
    id: "protected",
    method: "POST" as const,
    params: Object.freeze({}),
    pattern: "/protected" as const,
  },
  signal: new AbortController().signal,
  url: new URL("https://example.com/protected"),
});

const providerFrom = (auth: BetterAuthConfiguredInstance) => {
  const manifest = betterAuthPlugin({ auth });
  const contribution = manifest.setup({
    capabilities: {
      get: () => undefined,
      require() {
        throw new Error("No capabilities are required.");
      },
    },
    diagnostics: {
      warn() {},
    },
  });
  const provider = contribution.authentication;
  if (provider === undefined) {
    throw new Error("Better Auth did not contribute authentication.");
  }
  return { manifest, provider };
};

describe("betterAuthPlugin", () => {
  it("does not project an API namespace", () => {
    // Given
    type BetterAuthServer = ReturnType<
      typeof createHotUpdater<
        undefined,
        readonly [ReturnType<typeof betterAuthPlugin>]
      >
    >;

    // When / Then
    expectTypeOf<BetterAuthServer["features"]>().toEqualTypeOf<
      Readonly<Record<never, never>>
    >();
  });

  it("maps a null session to anonymous", async () => {
    // Given
    const auth: BetterAuthConfiguredInstance = {
      api: { getSession: vi.fn(async () => null) },
    };

    // When
    const result = await providerFrom(auth).provider.authenticate(
      authenticationInput(),
    );

    // Then
    expect(result).toEqual({ kind: "anonymous" });
  });

  it("copies only the Better Auth user id into the principal", async () => {
    // Given
    const auth: BetterAuthConfiguredInstance = {
      api: {
        async getSession() {
          return {
            session: {
              cookie: "must-not-cross",
              token: "must-not-cross",
            },
            user: {
              email: "private@example.com",
              id: "user-123",
              name: "Private",
            },
          };
        },
      },
    };

    // When
    const result = await providerFrom(auth).provider.authenticate(
      authenticationInput(),
    );

    // Then
    expect(result).toEqual({
      kind: "authenticated",
      principal: { issuer: "better-auth", subject: "user-123" },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-cross");
    expect(JSON.stringify(result)).not.toContain("private@example.com");
  });

  it.each([{ status: "SERVICE_UNAVAILABLE" }, { statusCode: 503 }])(
    "maps an observable Better Auth 503 outage to unavailable",
    async (error) => {
      // Given
      const auth: BetterAuthConfiguredInstance = {
        api: {
          async getSession() {
            throw error;
          },
        },
      };

      // When
      const result = await providerFrom(auth).provider.authenticate(
        authenticationInput(),
      );

      // Then
      expect(result).toEqual({ kind: "unavailable" });
    },
  );

  it("rethrows unexpected failures for the kernel opaque 500 boundary", async () => {
    // Given
    const unexpected = Object.freeze({
      message: "database secret",
      status: "INTERNAL_SERVER_ERROR",
      statusCode: 500,
    });
    const auth: BetterAuthConfiguredInstance = {
      api: {
        async getSession() {
          throw unexpected;
        },
      },
    };

    // When
    const pending = providerFrom(auth).provider.authenticate(
      authenticationInput(),
    );

    // Then
    await expect(pending).rejects.toBe(unexpected);
  });

  it("passes only copied headers and never mutates the configured auth", async () => {
    // Given
    const received: object[] = [];
    const getSession: BetterAuthConfiguredInstance["api"]["getSession"] = vi.fn(
      async (input) => {
        received.push(input);
        input.headers.set("x-mutated", "inside-adapter");
        return null;
      },
    );
    const api = Object.freeze({ getSession });
    const auth: BetterAuthConfiguredInstance = Object.freeze({ api });
    const authKeys = Reflect.ownKeys(auth);
    const apiKeys = Reflect.ownKeys(api);
    const input = authenticationInput();

    // When
    const { manifest, provider } = providerFrom(auth);
    const contribution = manifest.setup({
      capabilities: {
        get: () => undefined,
        require() {
          throw new Error("No capabilities are required.");
        },
      },
      diagnostics: { warn() {} },
    });
    await provider.authenticate(input);

    // Then
    expect(Reflect.ownKeys(auth)).toEqual(authKeys);
    expect(Reflect.ownKeys(api)).toEqual(apiKeys);
    expect(Reflect.ownKeys(received[0] ?? {}).sort()).toEqual(["headers"]);
    expect(input.headers.has("x-mutated")).toBe(false);
    expect(manifest.requires).toEqual([]);
    expect(Reflect.ownKeys(contribution)).toEqual(["authentication"]);
    expect(Reflect.ownKeys(provider).sort()).toEqual(["authenticate", "id"]);
    expect(provider.id).toBe("better-auth");
  });
});
