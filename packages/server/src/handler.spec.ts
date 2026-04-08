import { type Bundle, NIL_UUID } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import { createHandler, type HandlerAPI } from "./handler";

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
  }) satisfies HandlerAPI<TestContext>;

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

  it("can mount only update-check routes", async () => {
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/hot-updater",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    const versionResponse = await handler(
      new Request("http://localhost/hot-updater/version"),
    );
    const bundlesResponse = await handler(
      new Request("http://localhost/hot-updater/api/bundles"),
    );
    const updateResponse = await handler(
      new Request(
        "http://localhost/hot-updater/app-version/ios/1.0.0/production/default/default",
      ),
    );

    expect(versionResponse.status).toBe(404);
    expect(bundlesResponse.status).toBe(404);
    expect(updateResponse.status).toBe(200);
  });

  it("can mount only bundle routes", async () => {
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/hot-updater",
      routes: {
        updateCheck: false,
        bundles: true,
      },
    });

    const channelsResponse = await handler(
      new Request("http://localhost/hot-updater/api/bundles/channels"),
    );
    const updateResponse = await handler(
      new Request(
        "http://localhost/hot-updater/app-version/ios/1.0.0/production/default/default",
      ),
    );

    expect(channelsResponse.status).toBe(200);
    await expect(channelsResponse.json()).resolves.toEqual({
      data: {
        channels: ["production"],
      },
    });
    expect(api.getChannels).toHaveBeenCalledWith(undefined);
    expect(updateResponse.status).toBe(404);
  });

  it("returns paginated bundle results in the response body", async () => {
    const api = createApi();
    api.getBundles.mockResolvedValue({
      data: [testBundle],
      pagination: {
        total: 51,
        hasNextPage: true,
        hasPreviousPage: true,
        currentPage: 6,
        totalPages: 26,
      },
    });
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles?channel=production&platform=ios&limit=2&offset=10",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Total-Count")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      data: [testBundle],
      pagination: {
        total: 51,
        hasNextPage: true,
        hasPreviousPage: true,
        currentPage: 6,
        totalPages: 26,
      },
    });
    expect(api.getBundles).toHaveBeenCalledWith(
      {
        where: {
          channel: "production",
          platform: "ios",
        },
        limit: 2,
        offset: 10,
      },
      undefined,
    );
  });

  it("passes cursor pagination params through to getBundles", async () => {
    const api = createApi();
    api.getBundles.mockResolvedValue({
      data: [testBundle],
      pagination: {
        total: 51,
        hasNextPage: true,
        hasPreviousPage: true,
        currentPage: 2,
        totalPages: 26,
        nextCursor: "bundle-1",
        previousCursor: "bundle-9",
      },
    });
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles?channel=production&limit=20&offset=20&after=bundle-20",
      ),
    );

    expect(response.status).toBe(200);
    expect(api.getBundles).toHaveBeenCalledWith(
      {
        where: {
          channel: "production",
        },
        limit: 20,
        offset: 20,
        cursor: {
          after: "bundle-20",
          before: undefined,
        },
      },
      undefined,
    );
  });

  it("supports cursor pagination without forcing a legacy offset", async () => {
    const api = createApi();
    api.getBundles.mockResolvedValue({
      data: [testBundle],
      pagination: {
        total: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 1,
        nextCursor: null,
        previousCursor: null,
      },
    });
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles?channel=production&limit=20&after=bundle-20",
      ),
    );

    expect(response.status).toBe(200);
    expect(api.getBundles).toHaveBeenCalledWith(
      {
        where: {
          channel: "production",
        },
        limit: 20,
        cursor: {
          after: "bundle-20",
          before: undefined,
        },
      },
      undefined,
    );
  });

  it("returns 400 when the platform route parameter is invalid", async () => {
    const api = createApi();
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request(
        "http://localhost/hot-updater/app-version/web/1.0.0/production/default/default",
      ),
    );

    await expect(response.json()).resolves.toEqual({
      error: "Invalid platform: web. Expected 'ios' or 'android'.",
    });
    expect(response.status).toBe(400);
    expect(api.getAppUpdateInfo).not.toHaveBeenCalled();
  });
});
