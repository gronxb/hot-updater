import { describe, expect, it } from "vitest";

import { createHandler } from "./handler";
import {
  createApi,
  CURRENT_PACKAGE_SDK_VERSION,
  NEXT_SDK_VERSION_FOR_TEST,
} from "./handler.testFixtures";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

describe("createHandler update routes", () => {
  it("serves a versioned handler extension without changing core routes", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/hot-updater",
      handlerExtensions: [
        async (request) =>
          new URL(request.url).pathname === "/hot-updater/storage/v2/objects"
            ? new Response("object-v2", { status: 206 })
            : undefined,
      ],
    });

    // When
    const extensionResponse = await handler(
      new Request("http://localhost/hot-updater/storage/v2/objects"),
    );
    const coreResponse = await handler(
      new Request("http://localhost/hot-updater/version"),
    );

    // Then
    expect(extensionResponse.status).toBe(206);
    await expect(extensionResponse.text()).resolves.toBe("object-v2");
    expect(coreResponse.status).toBe(200);
  });

  it("supports the app-version route without a cohort segment", async () => {
    const api = createApi();
    const handler = createHandler(api, { basePath: "/hot-updater" });
    const context = { env: { tenantId: "tenant-a" } };
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/app-version/ios/1.0.0/production/default/default",
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(api.getAppUpdateInfo).toHaveBeenCalledWith(
      {
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: "default",
        channel: "production",
        cohort: undefined,
        minBundleId: "default",
        platform: "ios",
      },
      context,
    );
  });

  it("keeps legacy no-update responses as null when SDK version is missing", async () => {
    const api = createApi();
    api.getAppUpdateInfo.mockResolvedValueOnce(null);
    const handler = createHandler(api, { basePath: "/hot-updater" });
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/app-version/ios/1.0.0/production/default/default",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it("returns UP_TO_DATE for no-update responses from SDK-versioned clients", async () => {
    const api = createApi();
    api.getAppUpdateInfo.mockResolvedValueOnce(null);
    const handler = createHandler(api, { basePath: "/hot-updater" });
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/app-version/ios/1.0.0/production/default/default",
        { headers: { "Hot-Updater-SDK-Version": NEXT_SDK_VERSION_FOR_TEST } },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "UP_TO_DATE" });
  });

  it("keeps no-update responses as null for unsupported SDK versions", async () => {
    const api = createApi();
    api.getAppUpdateInfo.mockResolvedValueOnce(null);
    const handler = createHandler(api, { basePath: "/hot-updater" });
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/app-version/ios/1.0.0/production/default/default",
        {
          headers: {
            "Hot-Updater-SDK-Version": CURRENT_PACKAGE_SDK_VERSION,
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it("supports the fingerprint route without a cohort segment", async () => {
    const api = createApi();
    const handler = createHandler(api, { basePath: "/hot-updater" });
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/fingerprint/android/fingerprint-123/production/default/default",
      ),
    );

    expect(response.status).toBe(200);
    expect(api.getAppUpdateInfo).toHaveBeenCalledWith(
      {
        _updateStrategy: "fingerprint",
        bundleId: "default",
        channel: "production",
        cohort: undefined,
        fingerprintHash: "fingerprint-123",
        minBundleId: "default",
        platform: "android",
      },
      undefined,
    );
  });

  it("supports the version route", async () => {
    const api = createApi();
    const handler = createHandler(api, { basePath: "/hot-updater" });
    const response = await handler(
      new Request("http://localhost/hot-updater/version"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: HOT_UPDATER_SERVER_VERSION,
      capabilities: {},
    });
  });
});
