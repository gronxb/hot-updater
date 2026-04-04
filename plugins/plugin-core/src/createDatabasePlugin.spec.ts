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
  rolloutCohortCount: 1000,
  targetCohorts: ["device-1", "device-2"],
};

describe("createDatabasePlugin", () => {
  it("replaces targetCohorts instead of merging array items", async () => {
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
      targetCohorts: ["device-2"],
    });
    await plugin.commitBundle();

    expect(commitBundle).toHaveBeenCalledWith({
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            targetCohorts: ["device-2"],
          },
        },
      ],
    });
  });

  it("preserves pending updates while allowing targetCohorts to be cleared", async () => {
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
    await plugin.updateBundle(baseBundle.id, { targetCohorts: null });
    await plugin.commitBundle();

    expect(commitBundle).toHaveBeenCalledWith({
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
            targetCohorts: null,
          },
        },
      ],
    });
  });

  it("preserves pending changes after a failed commit", async () => {
    const getBundleById = vi.fn(async (bundleId: string) =>
      bundleId === baseBundle.id ? baseBundle : null,
    );
    const commitBundle = vi
      .fn()
      .mockRejectedValueOnce(new Error("commit failed"))
      .mockResolvedValueOnce(undefined);

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () => ({
        getBundleById,
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
      enabled: false,
    });
    await expect(plugin.commitBundle()).rejects.toThrow("commit failed");
    await plugin.commitBundle();

    expect(getBundleById).toHaveBeenCalledTimes(1);
    expect(commitBundle).toHaveBeenNthCalledWith(1, {
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
          },
        },
      ],
    });
    expect(commitBundle).toHaveBeenNthCalledWith(2, {
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
          },
        },
      ],
    });
  });
});
