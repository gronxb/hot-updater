import { type Bundle, NIL_UUID } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import { createHandler, type HandlerAPI, type HandlerRoutes } from "./handler";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

const NEXT_SDK_VERSION_FOR_TEST = "0.31.0";
const CURRENT_PACKAGE_SDK_VERSION = "0.30.10";

type TestEnv = {
  tenantId: string;
};

type TestContext = {
  env: TestEnv;
};

const testBundle: Bundle = {
  id: "bundle-1",
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "hash123",
  gitCommitHash: null,
  message: "Test bundle",
  channel: "production",
  storageUri: "s3://test-bucket/bundles/bundle-1.zip",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
};

const createApi = () =>
  ({
    getAppUpdateInfo: vi
      .fn<HandlerAPI<TestContext>["getAppUpdateInfo"]>()
      .mockResolvedValue({
        fileHash: null,
        fileUrl: null,
        id: NIL_UUID,
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
      }),
    getBundleById: vi.fn<HandlerAPI<TestContext>["getBundleById"]>(),
    getBundles: vi.fn<HandlerAPI<TestContext>["getBundles"]>(),
    getChannels: vi
      .fn<HandlerAPI<TestContext>["getChannels"]>()
      .mockResolvedValue(["production"]),
    insertBundle: vi.fn<HandlerAPI<TestContext>["insertBundle"]>(),
    updateBundleById: vi.fn<HandlerAPI<TestContext>["updateBundleById"]>(),
    deleteBundleById: vi.fn<HandlerAPI<TestContext>["deleteBundleById"]>(),
    appendBundleEvent: vi.fn<HandlerAPI<TestContext>["appendBundleEvent"]>(),
  }) satisfies HandlerAPI<TestContext>;

const createManagementHandler = (
  api: HandlerAPI<TestContext>,
  routes: Partial<HandlerRoutes> = {},
) =>
  createHandler(api, {
    basePath: "/hot-updater",
    routes: {
      updateCheck: true,
      bundles: true,
      ...routes,
    },
  });

describe("createHandler", () => {
  it("supports the app-version route without a cohort segment", async () => {
    const api = createApi();
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request(
        "http://localhost/hot-updater/app-version/ios/1.0.0/production/default/default",
      ),
      {
        env: {
          tenantId: "tenant-a",
        },
      },
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
      {
        env: {
          tenantId: "tenant-a",
        },
      },
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
        {
          headers: {
            "Hot-Updater-SDK-Version": NEXT_SDK_VERSION_FOR_TEST,
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "UP_TO_DATE",
    });
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

  it("mounts the events route with update-check routes", async () => {
    const api = createApi();
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Hot-Updater-SDK-Version": "0.37.0",
        },
        body: JSON.stringify({
          type: "UPDATE_APPLIED",
          installId: "install-1",
          fromBundleId: "bundle-0",
          toBundleId: "bundle-1",
          platform: "ios",
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          updateStrategy: "appVersion",
          fingerprintHash: null,
        }),
      }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(api.appendBundleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "UPDATE_APPLIED",
        installId: "install-1",
        toBundleId: "bundle-1",
        sdkVersion: "0.37.0",
      }),
      undefined,
    );
  });

  it("returns 400 JSON for invalid event payloads", async () => {
    const api = createApi();
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "UPDATE_APPLIED" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid event field: platform",
    });
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("returns 500 JSON for internal event errors", async () => {
    const api = createApi();
    api.appendBundleEvent.mockRejectedValueOnce(new Error("db unavailable"));
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "RECOVERED",
          installId: "install-1",
          fromBundleId: "bundle-1",
          toBundleId: testBundle.id,
          platform: "ios",
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          updateStrategy: "appVersion",
          fingerprintHash: null,
        }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
  });

  it("does not mount event routes when update-check routes are disabled", async () => {
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/hot-updater",
      routes: {
        updateCheck: false,
        bundles: false,
      },
    });

    const response = await handler(
      new Request("http://localhost/hot-updater/events", { method: "POST" }),
    );

    expect(response.status).toBe(404);
  });

  it("mounts bundle routes when explicitly enabled", async () => {
    const api = createApi();
    api.getBundles.mockResolvedValueOnce({
      data: [],
      pagination: {
        total: 0,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 0,
      },
    });
    const handler = createManagementHandler(api);

    const response = await handler(
      new Request("http://localhost/hot-updater/api/bundles"),
    );

    expect(response.status).toBe(200);
    expect(api.getBundles).toHaveBeenCalledWith(
      {
        cursor: undefined,
        limit: 50,
        page: undefined,
        where: {},
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
    });
  });
});
