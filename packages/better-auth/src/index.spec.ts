import { createHotUpdater } from "@hot-updater/server";
import type { HotUpdaterAuthenticationProvider } from "@hot-updater/server/internal/first-party-plugin";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeDatabase } from "../../server/src/runtime.testFixtures";
import { betterAuthPlugin, type BetterAuthConfiguredInstance } from "./index";
import { createPluginSetupContext } from "./setupContext.testFixtures";

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

const isAuthenticationProvider = (
  value: unknown,
): value is HotUpdaterAuthenticationProvider =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "authenticate") === "function" &&
  typeof Reflect.get(value, "id") === "string";

const providerFrom = (auth: BetterAuthConfiguredInstance) => {
  const manifest = betterAuthPlugin({ auth });
  const contribution = manifest.setup(createPluginSetupContext());
  if (typeof contribution !== "object" || contribution === null) {
    throw new Error("Better Auth returned an invalid contribution.");
  }
  const provider = Reflect.get(contribution, "authentication");
  if (!isAuthenticationProvider(provider)) {
    throw new Error("Better Auth did not contribute authentication.");
  }
  return { manifest, provider };
};

describe("betterAuthPlugin", () => {
  it("does not authenticate public core routes without a policy", async () => {
    const getSession = vi.fn(async () => null);
    const server = createHotUpdater({
      database: createRuntimeDatabase(),
      plugins: [betterAuthPlugin({ auth: { api: { getSession } } })],
      routes: { bundles: true, updateCheck: true },
    });

    const responses = await Promise.all(
      [
        "/api/version",
        "/api/fingerprint/ios/fingerprint/production/0/builtin",
        "/api/fingerprint/ios/fingerprint/production/0/builtin/stable",
        "/api/app-version/ios/1.0.0/production/0/builtin",
        "/api/app-version/ios/1.0.0/production/0/builtin/stable",
        "/api/bundles",
      ].map((path) =>
        server.handler(new Request(`https://example.com${path}`)),
      ),
    );

    expect(responses.map(({ status }) => status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("maps a null session to anonymous", async () => {
    const auth: BetterAuthConfiguredInstance = {
      api: { getSession: vi.fn(async () => null) },
    };
    const result = await providerFrom(auth).provider.authenticate(
      authenticationInput(),
    );
    expect(result).toEqual({ kind: "anonymous" });
  });

  it.each([
    { status: "UNAUTHORIZED" },
    { status: "FORBIDDEN" },
    { statusCode: 401 },
    { statusCode: 403 },
  ])("maps a Better Auth credential rejection to anonymous", async (error) => {
    const auth: BetterAuthConfiguredInstance = {
      api: {
        async getSession() {
          throw error;
        },
      },
    };
    const result = await providerFrom(auth).provider.authenticate(
      authenticationInput(),
    );
    expect(result).toEqual({ kind: "anonymous" });
  });

  it("copies only the Better Auth user id into the principal", async () => {
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
    const result = await providerFrom(auth).provider.authenticate(
      authenticationInput(),
    );
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
      const auth: BetterAuthConfiguredInstance = {
        api: {
          async getSession() {
            throw error;
          },
        },
      };
      const result = await providerFrom(auth).provider.authenticate(
        authenticationInput(),
      );
      expect(result).toEqual({ kind: "unavailable" });
    },
  );

  it("rethrows unexpected failures for the kernel opaque 500 boundary", async () => {
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
    const pending = providerFrom(auth).provider.authenticate(
      authenticationInput(),
    );
    await expect(pending).rejects.toBe(unexpected);
  });

  it("passes only copied headers and never mutates the configured auth", async () => {
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
    const { manifest, provider } = providerFrom(auth);
    const contribution = manifest.setup(createPluginSetupContext());
    if (typeof contribution !== "object" || contribution === null) {
      throw new Error("Better Auth returned an invalid contribution.");
    }
    await provider.authenticate(input);
    expect(Reflect.ownKeys(auth)).toEqual(authKeys);
    expect(Reflect.ownKeys(api)).toEqual(apiKeys);
    expect(Reflect.ownKeys(received[0] ?? {}).sort()).toEqual(["headers"]);
    expect(input.headers.has("x-mutated")).toBe(false);
    expect(provider.id).toBe("better-auth");
  });
});
