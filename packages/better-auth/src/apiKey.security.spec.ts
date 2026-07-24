import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticateMatchedRoute } from "../../server/src/kernel/authentication";
import type { HotUpdaterMatchedRoute } from "../../server/src/kernel/contracts";
import {
  betterAuthPlugin,
  type BetterAuthApiKeyConfiguredInstance,
} from "./index";
import { createPluginSetupContext } from "./setupContext.testFixtures";

const SECRET = "better-auth-api-key-secret-b6c2";
const route: HotUpdaterMatchedRoute = {
  access: { kind: "protected" },
  id: "protected",
  method: "POST",
  params: {},
  pattern: "/protected",
};

const kernelAuthentication = (
  auth: BetterAuthApiKeyConfiguredInstance,
  headers = new Headers({ "x-api-key": "client-key" }),
) => {
  const provider = betterAuthPlugin({
    apiKey: { configId: "mobile" },
    auth,
  }).setup(createPluginSetupContext()).authentication;
  if (provider === undefined) {
    throw new Error("missing authentication contribution");
  }
  return authenticateMatchedRoute({
    headers,
    provider,
    route,
    signal: new AbortController().signal,
    url: new URL("https://example.com/protected"),
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Better Auth API-key security conformance", () => {
  it("projects only the verified referenceId into the principal", async () => {
    // Given
    const auth: BetterAuthApiKeyConfiguredInstance = {
      api: {
        async verifyApiKey() {
          return {
            error: null,
            key: {
              id: SECRET,
              key: SECRET,
              metadata: { secret: SECRET },
              referenceId: "mobile-client",
            },
            valid: true,
          };
        },
      },
    };

    // When
    const result = await kernelAuthentication(auth);

    // Then
    expect(result.kind).toBe("authenticated");
    if (result.kind === "authenticated") {
      expect(result.context.principal).toEqual({
        issuer: "better-auth-api-key",
        subject: "mobile-client",
      });
      expect(JSON.stringify(result.context.principal)).not.toContain(SECRET);
    }
  });

  it.each([
    {
      name: "malformed result",
      verify: async () => ({
        error: null,
        key: {
          get referenceId() {
            throw new Error(SECRET);
          },
        },
        valid: true,
      }),
    },
    {
      name: "unexpected failure",
      verify: async () => {
        throw new Error(SECRET);
      },
    },
  ])("returns an opaque 500 for a $name", async ({ verify }) => {
    // Given
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const warnLog = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const auth: BetterAuthApiKeyConfiguredInstance = {
      api: { verifyApiKey: verify },
    };

    // When
    const result = await kernelAuthentication(auth);

    // Then
    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.response.status).toBe(500);
      expect(await result.response.text()).not.toContain(SECRET);
    }
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();
  });

  it("does not mutate caller-owned permission configuration", async () => {
    // Given
    const requiredPermissions = {
      releases: ["read"],
    };
    const auth: BetterAuthApiKeyConfiguredInstance = {
      api: {
        async verifyApiKey(input) {
          input.body.permissions?.releases?.push(SECRET);
          return {
            error: { code: "KEY_NOT_FOUND" },
            key: null,
            valid: false,
          };
        },
      },
    };
    const provider = betterAuthPlugin({
      apiKey: {
        configId: "mobile",
        requiredPermissions,
      },
      auth,
    }).setup(createPluginSetupContext()).authentication;
    if (provider === undefined) {
      throw new Error("missing authentication contribution");
    }

    // When
    await provider.authenticate({
      headers: new Headers({ "x-api-key": "client-key" }),
      method: "POST",
      route,
      signal: new AbortController().signal,
      url: new URL("https://example.com/protected"),
    });

    // Then
    expect(requiredPermissions).toEqual({ releases: ["read"] });
  });
});
