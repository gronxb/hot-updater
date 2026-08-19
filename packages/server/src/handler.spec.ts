import { describe, expect, it, vi } from "vitest";

import { createHandlers } from "./handler";
import { createApi } from "./handler.testFixtures";
import { HOT_UPDATER_INFRASTRUCTURE_GENERATION } from "./handlerVersionRoutes";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

describe("createHandlers client routes", () => {
  it("reports the v1 infrastructure generation", async () => {
    const handler = createHandlers(createApi()).client;
    const response = await handler(new Request("http://localhost/version"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      infrastructureGeneration: HOT_UPDATER_INFRASTRUCTURE_GENERATION,
      version: HOT_UPDATER_SERVER_VERSION,
    });
  });

  it.each([
    "/app-version/ios/1.0.0/production/default/default",
    "/fingerprint/android/fingerprint-123/production/default/default",
  ])("does not expose the v0 route %s", async (path) => {
    const handler = createHandlers(createApi()).client;

    const response = await handler(new Request(`http://localhost${path}`));

    expect(response.status).toBe(404);
  });

  it.each([
    "/v2/release-catalogs/app-version/default/ios/cHJvZHVjdGlvbg/1.0.0",
    "/v2/artifacts/target-bundle/from/current-bundle",
  ])("does not expose the version-prefixed route %s", async (path) => {
    const handler = createHandlers(createApi()).client;

    const response = await handler(new Request(`http://localhost${path}`));

    expect(response.status).toBe(404);
  });

  it("does not match the admin mount namespace", async () => {
    const handler = createHandlers(createApi()).client;

    const response = await handler(
      new Request("http://localhost/admin/channels"),
    );

    expect(response.status).toBe(404);
  });

  it("does not expose provider errors from the public client handler", async () => {
    const api = {
      ...createApi(),
      getReleaseCatalog: vi
        .fn()
        .mockRejectedValue(new Error("private database connection details")),
    };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const handler = createHandlers(api).client;

    const response = await handler(
      new Request(
        "http://localhost/release-catalogs/app-version/default/ios/cHJvZHVjdGlvbg/1.0.0",
      ),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Hot Updater handler error:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
