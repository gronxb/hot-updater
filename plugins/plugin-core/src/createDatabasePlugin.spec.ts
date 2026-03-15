import { describe, expect, it, vi } from "vitest";
import { createDatabasePlugin } from "./createDatabasePlugin";
import type { Bundle } from "./types";

const baseBundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutPercentage: 100,
  targetDeviceIds: ["device-1", "device-2"],
};

describe("createDatabasePlugin", () => {
  it("replaces targetDeviceIds instead of merging array items", async () => {
    const commitBundle = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () => ({
        getBundleById: async (bundleId) =>
          bundleId === baseBundle.id ? baseBundle : null,
        getBundles: async () => ({
          data: [baseBundle],
          pagination: {
            total: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 1,
          },
        }),
        getChannels: async () => ["production"],
        commitBundle,
      }),
    })({})();

    await plugin.updateBundle(baseBundle.id, {
      targetDeviceIds: ["device-2"],
    });
    await plugin.commitBundle();

    expect(commitBundle).toHaveBeenCalledWith({
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            targetDeviceIds: ["device-2"],
          },
        },
      ],
    });
  });

  it("preserves pending updates while allowing targetDeviceIds to be cleared", async () => {
    const commitBundle = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () => ({
        getBundleById: async (bundleId) =>
          bundleId === baseBundle.id ? baseBundle : null,
        getBundles: async () => ({
          data: [baseBundle],
          pagination: {
            total: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 1,
          },
        }),
        getChannels: async () => ["production"],
        commitBundle,
      }),
    })({})();

    await plugin.updateBundle(baseBundle.id, { enabled: false });
    await plugin.updateBundle(baseBundle.id, { targetDeviceIds: null });
    await plugin.commitBundle();

    expect(commitBundle).toHaveBeenCalledWith({
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
            targetDeviceIds: null,
          },
        },
      ],
    });
  });
});
