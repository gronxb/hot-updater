import { describe, expect, it } from "vitest";

import { createHandler } from "./handler";
import { createApi } from "./handler.testFixtures";
import { HOT_UPDATER_INFRASTRUCTURE_GENERATION } from "./handlerVersionRoutes";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

describe("createHandler version routes", () => {
  it("reports the v1 infrastructure generation", async () => {
    const handler = createHandler(createApi(), { basePath: "/hot-updater" });
    const response = await handler(
      new Request("http://localhost/hot-updater/version"),
    );

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
    const handler = createHandler(createApi(), { basePath: "/hot-updater" });

    const response = await handler(
      new Request(`http://localhost/hot-updater${path}`),
    );

    expect(response.status).toBe(404);
  });

  it.each([
    "/v2/release-catalogs/app-version/default/ios/cHJvZHVjdGlvbg/1.0.0",
    "/v2/artifacts/target-bundle/from/current-bundle",
  ])("does not expose the version-prefixed route %s", async (path) => {
    const handler = createHandler(createApi(), { basePath: "/hot-updater" });

    const response = await handler(
      new Request(`http://localhost/hot-updater${path}`),
    );

    expect(response.status).toBe(404);
  });
});
