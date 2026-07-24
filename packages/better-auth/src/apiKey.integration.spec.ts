import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeDatabase } from "../../server/src/runtime.testFixtures";
import { betterAuthPlugin } from "./index";

const createApiKeyProtectedServer = (
  verifyApiKey = vi.fn(async () => ({
    error: null,
    key: { referenceId: "mobile-client" },
    valid: true,
  })),
) => ({
  server: createHotUpdater({
    database: createRuntimeDatabase(),
    plugins: [
      betterAuthPlugin({
        apiKey: { configId: "mobile" },
        auth: { api: { verifyApiKey } },
      }),
    ],
    routes: {
      bundles: { access: { kind: "public" } },
      updateCheck: true,
    },
  }),
  verifyApiKey,
});

describe("Better Auth API-key route protection", () => {
  it.each([
    ["version", "/api/version"],
    ["update check", "/api/app-version/ios/1.0.0/production/minimum/bundle"],
    ["bundle management", "/api/api/bundles"],
  ])("requires a key for the public %s route", async (_name, path) => {
    // Given
    const { server, verifyApiKey } = createApiKeyProtectedServer();

    // When
    const response = await server.handler(
      new Request(`https://example.com${path}`),
    );

    // Then
    expect(response.status).toBe(401);
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it("allows a verified key to reach the version route", async () => {
    // Given
    const { server, verifyApiKey } = createApiKeyProtectedServer();

    // When
    const response = await server.handler(
      new Request("https://example.com/api/version", {
        headers: { "x-api-key": "client-key" },
      }),
    );

    // Then
    expect(response.status).toBe(200);
    expect(verifyApiKey).toHaveBeenCalledWith({
      body: { configId: "mobile", key: "client-key" },
    });
  });
});
