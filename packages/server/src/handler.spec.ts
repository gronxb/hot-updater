import { NIL_UUID } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";
import { createHandler, type HandlerAPI } from "./handler";

type TestEnv = {
  tenantId: string;
};

const createApi = (): HandlerAPI<TestEnv> => ({
  getAppUpdateInfo: vi.fn().mockResolvedValue({
    fileHash: null,
    fileUrl: null,
    id: NIL_UUID,
    message: null,
    shouldForceUpdate: true,
    status: "ROLLBACK",
  }),
  getBundleById: vi.fn(),
  getBundles: vi.fn(),
  getChannels: vi.fn(),
  insertBundle: vi.fn(),
  updateBundleById: vi.fn(),
  deleteBundleById: vi.fn(),
});

describe("createHandler", () => {
  it("keeps the legacy app-version route without a cohort segment", async () => {
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
      expect.objectContaining({
        env: {
          tenantId: "tenant-a",
        },
        request: expect.any(Request),
      }),
    );
  });

  it("keeps the legacy fingerprint route without a cohort segment", async () => {
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
      expect.objectContaining({
        request: expect.any(Request),
      }),
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
    expect(updateResponse.status).toBe(404);
  });
});
