import type { Bundle } from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("mockDatabase", () => {
  let plugin: ReturnType<ReturnType<typeof mockDatabase>>;
  let pluginWithBundles: ReturnType<ReturnType<typeof mockDatabase>>;
  let DEFAULT_BUNDLES_MOCK: Bundle[];

  beforeEach(() => {
    DEFAULT_BUNDLES_MOCK = JSON.parse(JSON.stringify(DEFAULT_BUNDLES));
    plugin = mockDatabase({ latency: DEFAULT_LATENCY })({ cwd: "" });
    pluginWithBundles = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: DEFAULT_BUNDLES_MOCK,
    })({ cwd: "" });
  });

  it("should return a database plugin", async () => {
    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });

    expect(bundles.data).toEqual([]);
  });

  it("should return a database plugin with initial bundles", async () => {
    const bundles = await pluginWithBundles.getBundles({
      limit: 20,
      offset: 0,
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

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.appendBundle(bundle3);
    await plugin.commitBundle();

    const result = await plugin.getBundles({
      where: { channel: "production" },
      limit: 20,
      offset: 0,
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

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.appendBundle(bundle3);
    await plugin.commitBundle();

    const firstPage = await plugin.getBundles({
      where: { channel: "production" },
      limit: 2,
      offset: 0,
    });

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.pagination).toEqual({
      total: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 2,
    });

    const secondPage = await plugin.getBundles({
      where: { channel: "production" },
      limit: 2,
      offset: 2,
    });

    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.pagination).toEqual({
      total: 3,
      hasNextPage: false,
      hasPreviousPage: true,
      currentPage: 2,
      totalPages: 2,
    });
  });

  it("should append a bundle", async () => {
    await plugin.appendBundle(DEFAULT_BUNDLES_MOCK[0]);
    await plugin.commitBundle();

    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });

    expect(bundles.data).toEqual([DEFAULT_BUNDLES_MOCK[0]]);
  });

  it("should update a bundle", async () => {
    const singleBundlePlugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
    })({ cwd: "" });

    await singleBundlePlugin.updateBundle(DEFAULT_BUNDLES_MOCK[0].id, {
      enabled: false,
    });
    await singleBundlePlugin.commitBundle();

    const bundles = await singleBundlePlugin.getBundles({
      limit: 20,
      offset: 0,
    });

    expect(bundles.data).toEqual([
      {
        ...DEFAULT_BUNDLES_MOCK[0],
        enabled: false,
      },
    ]);
  });

  it("should get bundle by id", async () => {
    const bundle = await pluginWithBundles.getBundleById(
      DEFAULT_BUNDLES_MOCK[0].id,
    );

    expect(bundle).toEqual(DEFAULT_BUNDLES_MOCK[0]);
  });

  it("should throw error, if bundle not found during update", async () => {
    const singleBundlePlugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
    })({ cwd: "" });

    await expect(
      singleBundlePlugin.updateBundle("00000000-0000-0000-0000-000000000001", {
        enabled: false,
      }),
    ).rejects.toThrowError("targetBundleId not found");
  });

  it("should sort bundles by id", async () => {
    const bundles = await pluginWithBundles.getBundles({
      limit: 20,
      offset: 0,
    });

    expect(bundles.data).toEqual(DEFAULT_BUNDLES_MOCK);
  });

  it("should delete a bundle successfully", async () => {
    // Get initial bundles and verify count
    const bundlesBefore = await pluginWithBundles.getBundles({
      limit: 20,
      offset: 0,
    });
    expect(bundlesBefore.data).toHaveLength(2);

    // Store the IDs for comparison
    const firstBundleId = bundlesBefore.data[0].id;
    const secondBundleId = bundlesBefore.data[1].id;

    // Delete first bundle
    await pluginWithBundles.deleteBundle(bundlesBefore.data[0]);
    await pluginWithBundles.commitBundle();

    // Verify deletion
    const bundlesAfter = await pluginWithBundles.getBundles({
      limit: 20,
      offset: 0,
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

    await plugin.deleteBundle(nonExistentBundle);
    await expect(plugin.commitBundle()).rejects.toThrow(
      "Bundle with id non-existent-bundle not found",
    );
  });

  it("should throw error when deleting from empty plugin", async () => {
    await plugin.deleteBundle(DEFAULT_BUNDLES_MOCK[0]);
    await expect(plugin.commitBundle()).rejects.toThrow(
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
    )({ cwd: "" });

    await pluginWithHook.deleteBundle(DEFAULT_BUNDLES_MOCK[0]);
    await pluginWithHook.commitBundle();

    // Hook should be called only once from commitBundle
    expect(mockHook).toHaveBeenCalledTimes(2);
  });

  it("should delete bundles and update getBundleById results", async () => {
    const initialBundles = await pluginWithBundles.getBundles({
      limit: 20,
      offset: 0,
    });

    const bundleToDelete = initialBundles.data[0];

    // Verify bundle exists before deletion
    const bundleBefore = await pluginWithBundles.getBundleById(
      bundleToDelete.id,
    );
    expect(bundleBefore).not.toBeNull();

    // Delete bundle
    await pluginWithBundles.deleteBundle(bundleToDelete);
    await pluginWithBundles.commitBundle();

    // Verify bundle no longer exists
    const bundleAfter = await pluginWithBundles.getBundleById(
      bundleToDelete.id,
    );
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
    })({ cwd: "" });

    // Verify both channels exist
    const channelsBefore = await testPlugin.getChannels();
    expect(channelsBefore).toEqual(["production", "staging"]);

    // Delete staging bundle
    const stagingBundle = testBundles.find((b) => b.id === "bundle-staging")!;
    await testPlugin.deleteBundle(stagingBundle);
    await testPlugin.commitBundle();

    // Verify only production channel remains
    const channelsAfter = await testPlugin.getChannels();
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
    })({ cwd: "" });

    // Delete middle bundle
    const bundleToDelete = testBundles.find((b) => b.id === "bundle-2")!;
    await testPlugin.deleteBundle(bundleToDelete);
    await testPlugin.commitBundle();

    // Get first page with limit 2
    const firstPage = await testPlugin.getBundles({
      limit: 2,
      offset: 0,
    });

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.data.map((b) => b.id)).toEqual(["bundle-1", "bundle-3"]);
    expect(firstPage.pagination.total).toBe(2);
    expect(firstPage.pagination.hasNextPage).toBe(false);
  });

  it("should handle latency simulation during deletion", async () => {
    const latencyPlugin = mockDatabase({
      latency: { min: 10, max: 20 },
      initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
    })({ cwd: "" });

    const startTime = Date.now();
    await latencyPlugin.deleteBundle(DEFAULT_BUNDLES_MOCK[0]);
    await latencyPlugin.commitBundle();
    const endTime = Date.now();

    // Should take at least minimum latency
    expect(endTime - startTime).toBeGreaterThanOrEqual(10);
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

    // Add bundle
    await plugin.appendBundle(newBundle);
    await plugin.commitBundle();

    // Verify bundle exists
    const bundleExists = await plugin.getBundleById("new-bundle");
    expect(bundleExists).toEqual(newBundle);

    // Delete bundle
    await plugin.deleteBundle(newBundle);
    await plugin.commitBundle();

    // Verify bundle is deleted
    const bundleAfterDelete = await plugin.getBundleById("new-bundle");
    expect(bundleAfterDelete).toBeNull();

    // Verify empty list
    const allBundles = await plugin.getBundles({ limit: 20, offset: 0 });
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

    // Add first bundle, commit it, then delete it, then add second bundle
    await plugin.appendBundle(bundle1);
    await plugin.commitBundle();

    await plugin.deleteBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.commitBundle();

    // Should only have bundle2
    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });
    expect(bundles.data).toHaveLength(1);
    expect(bundles.data[0].id).toBe("bundle2");
  });
});
