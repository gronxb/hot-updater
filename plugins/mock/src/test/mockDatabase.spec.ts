import type { Bundle } from "@hot-updater/core";
import { describe, expect, it, beforeEach } from "vitest";
import { mockDatabase } from "../mockDatabase";

const DEFAULT_BUNDLES_MOCK: Bundle[] = [
  {
    id: "0194ed78-ee7f-7d55-88f2-0511cbacc8f1",
    enabled: true,
    channel: "production",
    shouldForceUpdate: false,
    fileHash: "1234",
    gitCommitHash: "5678",
    platform: "ios",
    targetAppVersion: "1.0.x",
    message: null,
    storageUri:
      "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip",
    fingerprintHash: null,
  },
  {
    id: "0194ed78-d791-753c-ba37-abb7259edcc8",
    enabled: true,
    channel: "production",
    shouldForceUpdate: false,
    fileHash: "1234",
    gitCommitHash: "5678",
    platform: "ios",
    targetAppVersion: "1.0.x",
    message: null,
    storageUri:
      "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip",
    fingerprintHash: null,
  },
];

const DEFAULT_LATENCY = { min: 0, max: 0 };

describe("mockDatabase", () => {
  let plugin: ReturnType<ReturnType<typeof mockDatabase>>;
  let pluginWithBundles: ReturnType<ReturnType<typeof mockDatabase>>;

  beforeEach(() => {
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
      platform: "android",
      targetAppVersion: "2.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    const bundle2 = {
      id: "bundle2",
      channel: "production",
      enabled: false,
      shouldForceUpdate: false,
      fileHash: "hash2",
      gitCommitHash: "commit2",
      message: "bundle 2",
      platform: "ios",
      targetAppVersion: "1.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    const bundle3 = {
      id: "bundle3",
      channel: "staging",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash3",
      gitCommitHash: "commit3",
      message: "bundle 3",
      platform: "android",
      targetAppVersion: "1.5.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

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
      platform: "android",
      targetAppVersion: "2.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    const bundle2 = {
      id: "bundle2",
      channel: "production",
      enabled: false,
      shouldForceUpdate: false,
      fileHash: "hash2",
      gitCommitHash: "commit2",
      message: "bundle 2",
      platform: "ios",
      targetAppVersion: "1.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    const bundle3 = {
      id: "bundle3",
      channel: "production",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash3",
      gitCommitHash: "commit3",
      message: "bundle 3",
      platform: "android",
      targetAppVersion: "1.5.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

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

  it("should throw error, if targetBundleId not found", async () => {
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
});
