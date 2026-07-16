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
    appendBundleEvent:
      vi.fn<NonNullable<HandlerAPI<TestContext>["appendBundleEvent"]>>(),
    getBundleEventSummary: vi
      .fn<NonNullable<HandlerAPI<TestContext>["getBundleEventSummary"]>>()
      .mockResolvedValue({ installed: 0, recovered: 0 }),
    getBundleEventAnalytics: vi
      .fn<NonNullable<HandlerAPI<TestContext>["getBundleEventAnalytics"]>>()
      .mockResolvedValue({
        summary: { installed: 0, recovered: 0 },
        series: { installed: [], recovered: [] },
        cohorts: { installed: [], recovered: [] },
        recentEvents: {
          data: [],
          pagination: { total: 0, limit: 50, offset: 0 },
        },
      }),
    getBundleEventOverview: vi
      .fn<NonNullable<HandlerAPI<TestContext>["getBundleEventOverview"]>>()
      .mockResolvedValue({ trackedInstallations: 0, bundles: [] }),
    searchInstallations: vi
      .fn<NonNullable<HandlerAPI<TestContext>["searchInstallations"]>>()
      .mockResolvedValue({
        data: [],
        pagination: { total: 0, limit: 50, offset: 0 },
      }),
    getInstallationHistory: vi
      .fn<NonNullable<HandlerAPI<TestContext>["getInstallationHistory"]>>()
      .mockResolvedValue({
        data: [],
        pagination: { total: 0, limit: 50, offset: 0 },
      }),
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

  it("does not mount event routes when the database omits the capability", async () => {
    // Given
    const {
      appendBundleEvent: _appendBundleEvent,
      getBundleEventSummary: _getBundleEventSummary,
      getBundleEventAnalytics: _getBundleEventAnalytics,
      getBundleEventOverview: _getBundleEventOverview,
      searchInstallations: _searchInstallations,
      getInstallationHistory: _getInstallationHistory,
      ...api
    } = createApi();
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

    // When
    const appendResponse = await handler(
      new Request("http://localhost/hot-updater/events", { method: "POST" }),
    );
    const summaryResponse = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles/bundle-1/events/summary",
      ),
    );
    const bundlesResponse = await handler(
      new Request("http://localhost/hot-updater/api/bundles"),
    );

    // Then
    expect(appendResponse.status).toBe(404);
    expect(summaryResponse.status).toBe(404);
    expect(bundlesResponse.status).toBe(200);
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

  it("returns 413 before parsing an oversized event body", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, { basePath: "/hot-updater" });

    // When
    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(17 * 1024) }),
      }),
    );

    // Then
    expect(response.status).toBe(413);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for oversized event string fields", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, { basePath: "/hot-updater" });

    // When
    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "UPDATE_APPLIED",
          installId: "x".repeat(1025),
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

    // Then
    expect(response.status).toBe(400);
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

  it("serves bundle event summaries through management routes", async () => {
    const api = createApi();
    api.getBundleEventSummary.mockResolvedValueOnce({
      installed: 3,
      recovered: 1,
    });
    const handler = createManagementHandler(api);

    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles/bundle-1/events/summary",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      installed: 3,
      recovered: 1,
    });
    expect(api.getBundleEventSummary).toHaveBeenCalledWith(
      "bundle-1",
      undefined,
    );
  });

  it("forwards bounded analytics pagination and window parameters", async () => {
    const api = createApi();
    const handler = createManagementHandler(api);

    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles/bundle-1/events/analytics?window=7d&limit=25&offset=10",
      ),
    );

    expect(response.status).toBe(200);
    expect(api.getBundleEventAnalytics).toHaveBeenCalledWith(
      "bundle-1",
      "7d",
      25,
      10,
      undefined,
    );
  });

  it("serves installation search and append-only history", async () => {
    const api = createApi();
    const handler = createManagementHandler(api);

    const searchResponse = await handler(
      new Request(
        "http://localhost/hot-updater/api/installations?query=hot-updater-e2e&limit=20&offset=4",
      ),
    );
    const historyResponse = await handler(
      new Request(
        "http://localhost/hot-updater/api/installations/install-1/events?limit=30&offset=2",
      ),
    );

    expect(searchResponse.status).toBe(200);
    expect(historyResponse.status).toBe(200);
    expect(api.searchInstallations).toHaveBeenCalledWith(
      "hot-updater-e2e",
      20,
      4,
      undefined,
    );
    expect(api.getInstallationHistory).toHaveBeenCalledWith(
      "install-1",
      30,
      2,
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
