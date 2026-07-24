import { describe, expect, it, vi } from "vitest";

import { betterAuthPlugin } from "./index";
import { createPluginSetupContext } from "./setupContext.testFixtures";

const auth = {
  api: {
    getSession: vi.fn(async () => null),
    verifyApiKey: vi.fn(async () => ({
      error: { code: "KEY_NOT_FOUND" },
      key: null,
      valid: false,
    })),
  },
};

describe("betterAuthPlugin API-key configuration", () => {
  it("protects every Hot Updater route only in API-key mode", () => {
    // Given
    const setupContext = createPluginSetupContext();

    // When
    const apiKeyContribution = betterAuthPlugin({
      apiKey: { configId: "mobile" },
      auth,
    }).setup(setupContext);
    const sessionContribution = betterAuthPlugin({ auth }).setup(setupContext);

    // Then
    expect(Reflect.get(apiKeyContribution, "routePolicy")).toEqual({
      kind: "protect-all",
    });
    expect(Reflect.has(sessionContribution, "routePolicy")).toBe(false);
  });

  it.each(["", "invalid header", "x-api-key:", "x-api-key\r\n"])(
    "rejects an invalid custom header name %# at construction",
    (headerName) => {
      // Given / When
      const construct = () =>
        betterAuthPlugin({
          apiKey: {
            configId: "mobile",
            headerName,
          },
          auth,
        });

      // Then
      expect(construct).toThrow();
      expect(auth.api.verifyApiKey).not.toHaveBeenCalled();
    },
  );

  it.each(["", " padded ", "line\u0001break", "\ud800", "c".repeat(256)])(
    "rejects an invalid configId %# at construction",
    (configId) => {
      // Given / When
      const construct = () =>
        betterAuthPlugin({
          apiKey: { configId },
          auth,
        });

      // Then
      expect(construct).toThrow();
      expect(auth.api.verifyApiKey).not.toHaveBeenCalled();
    },
  );
});
