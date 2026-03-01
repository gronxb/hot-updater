import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";
import { createHandler, type HandlerAPI } from "./handler";

function createApiMock(): HandlerAPI {
  return {
    getAppUpdateInfo: vi.fn().mockResolvedValue(null),
    getBundleById: vi.fn().mockResolvedValue(null),
    getBundles: vi.fn().mockResolvedValue({
      data: [] as Bundle[],
      pagination: {
        total: 0,
        limit: 50,
        offset: 0,
        hasNext: false,
        hasPrev: false,
      },
    }),
    insertBundle: vi.fn().mockResolvedValue(undefined),
    deleteBundleById: vi.fn().mockResolvedValue(undefined),
    getChannels: vi.fn().mockResolvedValue([]),
  };
}

describe("handler incremental route integration", () => {
  it("passes currentHash query to app-version update route", async () => {
    const api = createApiMock();
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request(
        "http://localhost/hot-updater/app-version/ios/1.0.0/production/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002?currentHash=abc123",
      ),
    );

    expect(response.status).toBe(200);
    expect(api.getAppUpdateInfo).toHaveBeenCalledWith({
      _updateStrategy: "appVersion",
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      minBundleId: "00000000-0000-0000-0000-000000000001",
      bundleId: "00000000-0000-0000-0000-000000000002",
      currentHash: "abc123",
    });
  });

  it("passes empty currentHash when query exists but value is empty", async () => {
    const api = createApiMock();
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request(
        `http://localhost/hot-updater/app-version/ios/1.0.0/production/${NIL_UUID}/00000000-0000-0000-0000-000000000010?currentHash=`,
      ),
    );

    expect(response.status).toBe(200);
    expect(api.getAppUpdateInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        currentHash: "",
      }),
    );
  });

  it("passes null currentHash when query is omitted", async () => {
    const api = createApiMock();
    const handler = createHandler(api, { basePath: "/hot-updater" });

    const response = await handler(
      new Request(
        `http://localhost/hot-updater/fingerprint/android/fp-hash/production/${NIL_UUID}/00000000-0000-0000-0000-000000000011`,
      ),
    );

    expect(response.status).toBe(200);
    expect(api.getAppUpdateInfo).toHaveBeenCalledWith({
      _updateStrategy: "fingerprint",
      platform: "android",
      fingerprintHash: "fp-hash",
      channel: "production",
      minBundleId: NIL_UUID,
      bundleId: "00000000-0000-0000-0000-000000000011",
      currentHash: null,
    });
  });
});
