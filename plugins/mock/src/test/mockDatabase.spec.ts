import type { Bundle } from "@hot-updater/core";
import { stageDatabaseRuntimeBundleInsert } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setupGetUpdateInfoTestSuite } from "../../../../packages/test-utils/src/index";
import { mockDatabase } from "../mockDatabase";

const DEFAULT_BUNDLES: Bundle[] = [
  {
    id: "0194ed78-ee7f-7d55-88f2-0511cbacc8f1",
    enabled: true,
    channel: "production",
    shouldForceUpdate: false,
    fileHash: "1234",
    gitCommitHash: "5678",
    platform: "ios" as const,
    targetAppVersion: "1.0.x",
    message: null,
    storageUri:
      "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip",
    fingerprintHash: null,
    metadata: {},
  },
  {
    id: "0194ed78-d791-753c-ba37-abb7259edcc8",
    enabled: true,
    channel: "production",
    shouldForceUpdate: false,
    fileHash: "1234",
    gitCommitHash: "5678",
    platform: "ios" as const,
    targetAppVersion: "1.0.x",
    message: null,
    storageUri:
      "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip",
    fingerprintHash: null,
    metadata: {},
  },
];

const DEFAULT_LATENCY = { min: 0, max: 0 };

type MockRuntime = ReturnType<typeof mockDatabase>;

const stageBundleInsert = async (
  runtime: MockRuntime,
  bundle: Bundle,
): Promise<void> => {
  await stageDatabaseRuntimeBundleInsert(runtime, { bundle });
};

const getChannels = async (runtime: MockRuntime): Promise<string[]> => {
  const bundles = await runtime.bundles.list({ limit: 1000 });
  return Array.from(
    new Set(bundles.data.map((bundle) => bundle.channel)),
  ).sort();
};

describe("mockDatabase", () => {
  let plugin: MockRuntime;
  let pluginWithBundles: MockRuntime;
  let DEFAULT_BUNDLES_MOCK: Bundle[];

  beforeEach(() => {
    DEFAULT_BUNDLES_MOCK = JSON.parse(JSON.stringify(DEFAULT_BUNDLES));
    plugin = mockDatabase({ latency: DEFAULT_LATENCY });
    pluginWithBundles = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: DEFAULT_BUNDLES_MOCK,
    });
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo: async (bundles, args) => {
      const plugin = mockDatabase({
        latency: DEFAULT_LATENCY,
        initialBundles: JSON.parse(JSON.stringify(bundles)),
      });

      return plugin.updateInfo?.get(args) ?? null;
    },
  });

  it("should return a database plugin", async () => {
    const bundles = await plugin.bundles.list({ limit: 20 });

    expect(bundles.data).toEqual([]);
  });

  it("should return a database plugin with initial bundles", async () => {
    const bundles = await pluginWithBundles.bundles.list({
      limit: 20,
    });

    expect(bundles.data).toEqual(DEFAULT_BUNDLES_MOCK);
  });

  it("should return correct pagination info for single page", async () => {
    const bundle1 = {
      id: "bundle1",
      channel: "production",
      enabled: true,
      shouldForceUpdate: true,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "bundle 1",
      platform: "android" as const,
      targetAppVersion: "2.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    };

    const bundle2 = {
      id: "bundle2",
      channel: "production",
      enabled: false,
      shouldForceUpdate: false,
      fileHash: "hash2",
      gitCommitHash: "commit2",
      message: "bundle 2",
      platform: "ios" as const,
      targetAppVersion: "1.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    };

    const bundle3 = {
      id: "bundle3",
      channel: "staging",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash3",
      gitCommitHash: "commit3",
      message: "bundle 3",
      platform: "android" as const,
      targetAppVersion: "1.5.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    };

    await stageBundleInsert(plugin, bundle1);
    await stageBundleInsert(plugin, bundle2);
    await stageBundleInsert(plugin, bundle3);
    await plugin.commit();

    const result = await plugin.bundles.list({
      where: { channel: "production" },
      limit: 20,
    });

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe("bundle2");
    expect(result.data[1].id).toBe("bundle1");

    expect(result.pagination).toEqual({
      total: 2,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 1,
      nextCursor: null,
      previousCursor: null,
    });
  });

  it("should return correct pagination info for multiple pages", async () => {
    const bundle1 = {
      id: "bundle1",
      channel: "production",
      enabled: true,
      shouldForceUpdate: true,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "bundle 1",
      platform: "android" as const,
      targetAppVersion: "2.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    };

    const bundle2 = {
      id: "bundle2",
      channel: "production",
      enabled: false,
      shouldForceUpdate: false,
      fileHash: "hash2",
      gitCommitHash: "commit2",
      message: "bundle 2",
      platform: "ios" as const,
      targetAppVersion: "1.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    };

    const bundle3 = {
      id: "bundle3",
      channel: "production",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash3",
      gitCommitHash: "commit3",
      message: "bundle 3",
      platform: "android" as const,
      targetAppVersion: "1.5.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    };

    await stageBundleInsert(plugin, bundle1);
    await stageBundleInsert(plugin, bundle2);
    await stageBundleInsert(plugin, bundle3);
    await plugin.commit();

    const firstPage = await plugin.bundles.list({
      where: { channel: "production" },
      limit: 2,
    });

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.pagination).toEqual({
      total: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 2,
      nextCursor: "offset:1",
      previousCursor: null,
    });

    const secondPage = await plugin.bundles.list({
      where: { channel: "production" },
      limit: 2,
      cursor: {
        after: firstPage.pagination.nextCursor ?? undefined,
      },
    });

    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.pagination).toEqual({
      total: 3,
      hasNextPage: false,
      hasPreviousPage: true,
      currentPage: 2,
      totalPages: 2,
      nextCursor: null,
      previousCursor: "offset:2",
    });
  });

  it("should append a bundle", async () => {
    await stageBundleInsert(plugin, DEFAULT_BUNDLES_MOCK[0]);
    await plugin.commit();

    const bundles = await plugin.bundles.list({ limit: 20 });

    expect(bundles.data).toEqual([DEFAULT_BUNDLES_MOCK[0]]);
  });

  it("should update a bundle", async () => {
    const singleBundlePlugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
    });

    await singleBundlePlugin.bundles.update({
      bundleId: DEFAULT_BUNDLES_MOCK[0].id,
      patch: {
        enabled: false,
      },
    });
    await singleBundlePlugin.commit();

    const bundles = await singleBundlePlugin.bundles.list({
      limit: 20,
    });

    expect(bundles.data).toEqual([
      {
        ...DEFAULT_BUNDLES_MOCK[0],
        enabled: false,
      },
    ]);
  });

  it("should get bundle by id", async () => {
    const bundle = await pluginWithBundles.bundles.getById({
      bundleId: DEFAULT_BUNDLES_MOCK[0].id,
    });

    expect(bundle).toEqual(DEFAULT_BUNDLES_MOCK[0]);
  });

  it("should throw error, if bundle not found during update", async () => {
    const singleBundlePlugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
    });

    await singleBundlePlugin.bundles.update({
      bundleId: "00000000-0000-0000-0000-000000000001",
      patch: {
        enabled: false,
      },
    });
    await expect(singleBundlePlugin.commit()).rejects.toThrowError(
      "targetBundleId not found",
    );
  });

  it("should sort bundles by id", async () => {
    const bundles = await pluginWithBundles.bundles.list({
      limit: 20,
    });

    expect(bundles.data).toEqual(DEFAULT_BUNDLES_MOCK);
  });

  it("should delete a bundle successfully", async () => {
    // Get initial bundles and verify count
    const bundlesBefore = await pluginWithBundles.bundles.list({
      limit: 20,
    });
    expect(bundlesBefore.data).toHaveLength(2);

    // Store the IDs for comparison
    const firstBundleId = bundlesBefore.data[0].id;
    const secondBundleId = bundlesBefore.data[1].id;

    // Delete first bundle
    await pluginWithBundles.bundles.delete({
      bundleId: bundlesBefore.data[0].id,
    });
    await pluginWithBundles.commit();

    // Verify deletion
    const bundlesAfter = await pluginWithBundles.bundles.list({
      limit: 20,
    });
    expect(bundlesAfter.data).toHaveLength(1);

    // Verify the correct bundle remains
    expect(bundlesAfter.data[0].id).toBe(secondBundleId);

    // Verify the deleted bundle is no longer present
    expect(bundlesAfter.data[0].id).not.toBe(firstBundleId);
  });

  it("should throw error when bundle does not exist", async () => {
    const nonExistentBundle = {
      ...DEFAULT_BUNDLES_MOCK[0],
      id: "non-existent-bundle",
    };

    await plugin.bundles.delete({ bundleId: nonExistentBundle.id });
    await expect(plugin.commit()).rejects.toThrow(
      "Bundle with id non-existent-bundle not found",
    );
  });

  it("should throw error when deleting from empty plugin", async () => {
    await plugin.bundles.delete({ bundleId: DEFAULT_BUNDLES_MOCK[0].id });
    await expect(plugin.commit()).rejects.toThrow(
      `Bundle with id ${DEFAULT_BUNDLES_MOCK[0].id} not found`,
    );
  });

  it("should call onDatabaseUpdated hook when bundle is deleted", async () => {
    const mockHook = vi.fn();
    const pluginWithHook = mockDatabase(
      {
        latency: DEFAULT_LATENCY,
        initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
      },
      {
        onDatabaseUpdated: mockHook,
      },
    );

    await pluginWithHook.bundles.delete({
      bundleId: DEFAULT_BUNDLES_MOCK[0].id,
    });
    await pluginWithHook.commit();

    expect(mockHook).toHaveBeenCalledTimes(1);
  });

  it("should delete bundles and update getBundleById results", async () => {
    const initialBundles = await pluginWithBundles.bundles.list({
      limit: 20,
    });

    const bundleToDelete = initialBundles.data[0];

    // Verify bundle exists before deletion
    const bundleBefore = await pluginWithBundles.bundles.getById({
      bundleId: bundleToDelete.id,
    });
    expect(bundleBefore).not.toBeNull();

    // Delete bundle
    await pluginWithBundles.bundles.delete({ bundleId: bundleToDelete.id });
    await pluginWithBundles.commit();

    const bundleAfter = await pluginWithBundles.bundles.getById({
      bundleId: bundleToDelete.id,
    });
    expect(bundleAfter).toBeNull();
  });

  it("should delete bundles and update getChannels results", async () => {
    // Create plugin with bundles from different channels
    const testBundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLES_MOCK[0],
        id: "bundle-prod",
        channel: "production",
      },
      {
        ...DEFAULT_BUNDLES_MOCK[1],
        id: "bundle-staging",
        channel: "staging",
      },
    ];

    const testPlugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: testBundles,
    });

    const channelsBefore = await getChannels(testPlugin);
    expect(channelsBefore).toEqual(["production", "staging"]);

    await testPlugin.bundles.delete({ bundleId: "bundle-staging" });
    await testPlugin.commit();

    const channelsAfter = await getChannels(testPlugin);
    expect(channelsAfter).toEqual(["production"]);
  });

  it("should handle deletion with pagination correctly", async () => {
    const testBundles = [
      {
        ...DEFAULT_BUNDLES_MOCK[0],
        id: "bundle-1",
        channel: "production",
      },
      {
        ...DEFAULT_BUNDLES_MOCK[1],
        id: "bundle-2",
        channel: "production",
      },
      {
        ...DEFAULT_BUNDLES_MOCK[0],
        id: "bundle-3",
        channel: "production",
      },
    ];

    const testPlugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: testBundles,
    });

    await testPlugin.bundles.delete({ bundleId: "bundle-2" });
    await testPlugin.commit();

    const firstPage = await testPlugin.bundles.list({
      limit: 2,
    });

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.data.map((b) => b.id)).toEqual(["bundle-3", "bundle-1"]);
    expect(firstPage.pagination.total).toBe(2);
    expect(firstPage.pagination.hasNextPage).toBe(false);
  });

  it("should handle latency simulation during deletion", async () => {
    vi.useFakeTimers();
    const latencyPlugin = mockDatabase({
      latency: { min: 10, max: 10 },
      initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
    });

    try {
      await latencyPlugin.bundles.delete({
        bundleId: DEFAULT_BUNDLES_MOCK[0].id,
      });
      const commitPromise = latencyPlugin.commit();
      let committed = false;
      void commitPromise.then(() => {
        committed = true;
      });

      await vi.advanceTimersByTimeAsync(9);
      expect(committed).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await commitPromise;
      expect(committed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should work with appendBundle and deleteBundle workflow", async () => {
    const newBundle: Bundle = {
      id: "new-bundle",
      channel: "test",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "new-hash",
      gitCommitHash: "new-commit",
      message: "New test bundle",
      platform: "android" as const,
      targetAppVersion: "2.0.0",
      storageUri: "gs://test-bucket/new-bundle",
      fingerprintHash: null,
      metadata: {},
    };

    await stageBundleInsert(plugin, newBundle);
    await plugin.commit();

    const bundleExists = await plugin.bundles.getById({
      bundleId: "new-bundle",
    });
    expect(bundleExists).toEqual(newBundle);

    await plugin.bundles.delete({ bundleId: newBundle.id });
    await plugin.commit();

    const bundleAfterDelete = await plugin.bundles.getById({
      bundleId: "new-bundle",
    });
    expect(bundleAfterDelete).toBeNull();

    const allBundles = await plugin.bundles.list({ limit: 20 });
    expect(allBundles.data).toHaveLength(0);
  });

  it("should process mixed operations in sequence", async () => {
    const bundle1 = {
      id: "bundle1",
      channel: "production",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "bundle 1",
      platform: "android" as const,
      targetAppVersion: "2.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    };

    const bundle2 = {
      id: "bundle2",
      channel: "production",
      enabled: false,
      shouldForceUpdate: false,
      fileHash: "hash2",
      gitCommitHash: "commit2",
      message: "bundle 2",
      platform: "ios" as const,
      targetAppVersion: "1.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    };

    await stageBundleInsert(plugin, bundle1);
    await plugin.commit();

    await plugin.bundles.delete({ bundleId: bundle1.id });
    await stageBundleInsert(plugin, bundle2);
    await plugin.commit();

    const bundles = await plugin.bundles.list({ limit: 20 });
    expect(bundles.data).toHaveLength(1);
    expect(bundles.data[0].id).toBe("bundle2");
  });
});
