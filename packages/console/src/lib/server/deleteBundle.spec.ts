// @vitest-environment node

import type {
  Bundle,
  DatabaseClient,
  StoragePlugin,
  StoragePluginWith,
} from "@hot-updater/plugin-core";
import { createStoragePlugin as createCoreStoragePlugin } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteBundle, deleteBundles } from "./deleteBundle";

const baseBundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  platform: "ios",
  fileHash: "abc123",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
};

function createDatabaseClient(bundle: Bundle | null = baseBundle) {
  const bundles = bundle ? [bundle] : [];
  const databaseClient = {
    getChannels: vi.fn(),
    insertChannel: vi.fn(),
    deleteChannel: vi.fn(),
    getBundleById: vi.fn(async () => bundle),
    getBundles: vi.fn(async () => ({
      data: bundles,
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: bundles.length,
        totalPages: 1,
      },
    })),
    updateBundleById: vi.fn(),
    insertBundle: vi.fn(),
    deleteBundleById: vi.fn(),
    mutate: vi.fn(),
  } satisfies DatabaseClient;
  databaseClient.mutate.mockImplementation(async (operation) =>
    operation(databaseClient),
  );
  return databaseClient;
}

function createStoragePlugin(
  protocol = "s3",
  overrides?: Partial<StoragePlugin>,
): StoragePluginWith<"get" | "delete"> {
  const get =
    overrides?.get ??
    vi.fn(async ({ storageUri }: { storageUri: string }) => {
      const storageUrl = new URL(storageUri);
      const response = await fetch(
        `https://assets.example.com${storageUrl.pathname}`,
      );
      return { response: response.ok ? response : null };
    });
  return createCoreStoragePlugin({
    name: "mockStorage",
    protocol,
    get,
    delete:
      overrides?.delete ?? vi.fn(async () => ({ deleted: true as const })),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteBundle", () => {
  it("deletes the bundle from database and storage", async () => {
    const databaseClient = createDatabaseClient();
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundle(
      { bundleId: baseBundle.id },
      { databaseClient, storagePlugin },
    );

    expect(databaseClient.getBundles).toHaveBeenCalledWith({
      where: { id: { in: [baseBundle.id] } },
      limit: 1,
    });
    expect(databaseClient.mutate).toHaveBeenCalledOnce();
    expect(databaseClient.deleteBundleById).toHaveBeenCalledWith(baseBundle.id);
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: baseBundle.storageUri,
    });

    expect(
      databaseClient.deleteBundleById.mock.invocationCallOrder[0],
    ).toBeLessThan(deleteFromStorage.mock.invocationCallOrder[0]);
  });

  it("deletes multiple bundles with one database commit", async () => {
    const secondBundle = {
      ...baseBundle,
      id: "0195a408-8f13-7d9b-8df4-123456789abd",
      storageUri: "s3://bucket/second-bundle.zip",
    };
    const databaseClient = createDatabaseClient();
    databaseClient.getBundles.mockResolvedValue({
      data: [baseBundle, secondBundle],
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: 2,
        totalPages: 1,
      },
    });
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundles(
      { bundleIds: [baseBundle.id, secondBundle.id] },
      { databaseClient, storagePlugin },
    );

    expect(databaseClient.getBundles).toHaveBeenCalledOnce();
    expect(databaseClient.mutate).toHaveBeenCalledOnce();
    expect(databaseClient.deleteBundleById).toHaveBeenCalledTimes(2);
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: baseBundle.storageUri,
    });
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: secondBundle.storageUri,
    });
  });

  it("deletes found bundles and reports stale ids in the same batch", async () => {
    const databaseClient = createDatabaseClient();
    const storagePlugin = createStoragePlugin();

    await expect(
      deleteBundles(
        { bundleIds: [baseBundle.id, "missing-bundle"] },
        { databaseClient, storagePlugin },
      ),
    ).resolves.toEqual({
      deletedBundleIds: [baseBundle.id],
      missingBundleIds: ["missing-bundle"],
    });

    expect(databaseClient.mutate).toHaveBeenCalledOnce();
    expect(databaseClient.deleteBundleById).toHaveBeenCalledWith(baseBundle.id);
    expect(storagePlugin.delete).toHaveBeenCalledWith({
      storageUri: baseBundle.storageUri,
    });
  });

  it("deduplicates ids before database and storage deletion", async () => {
    const databaseClient = createDatabaseClient();
    const storagePlugin = createStoragePlugin();

    await deleteBundles(
      { bundleIds: [baseBundle.id, baseBundle.id] },
      { databaseClient, storagePlugin },
    );

    expect(databaseClient.getBundles).toHaveBeenCalledOnce();
    expect(databaseClient.mutate).toHaveBeenCalledOnce();
    expect(databaseClient.deleteBundleById).toHaveBeenCalledOnce();
    expect(storagePlugin.delete).toHaveBeenCalledOnce();
  });

  it("skips storage deletion for http urls", async () => {
    const databaseClient = createDatabaseClient({
      ...baseBundle,
      storageUri: "https://cdn.example.com/bundle.zip",
    });
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundle(
      { bundleId: baseBundle.id },
      { databaseClient, storagePlugin },
    );

    expect(databaseClient.deleteBundleById).toHaveBeenCalledOnce();
    expect(deleteFromStorage).not.toHaveBeenCalled();
  });

  it("uses an owning https plugin before the direct URL fallback", async () => {
    const storageUri = "https://cdn.example.com/bundle.zip";
    const databaseClient = createDatabaseClient({
      ...baseBundle,
      storageUri,
    });
    const deleteFromStorage = vi.fn(async () => ({ deleted: true as const }));
    const storagePlugin = createStoragePlugin("https", {
      delete: deleteFromStorage,
    });

    await deleteBundle(
      { bundleId: baseBundle.id },
      { databaseClient, storagePlugin },
    );

    expect(deleteFromStorage).toHaveBeenCalledWith({ storageUri });
  });

  it("throws before database deletion when the storage protocol is unsupported", async () => {
    const databaseClient = createDatabaseClient({
      ...baseBundle,
      storageUri: "r2://bucket/bundle.zip",
    });
    const storagePlugin = createStoragePlugin("s3");

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { databaseClient, storagePlugin },
      ),
    ).rejects.toThrow("No storage plugin for protocol: r2");

    expect(databaseClient.deleteBundleById).not.toHaveBeenCalled();
    expect(storagePlugin.delete).not.toHaveBeenCalled();
  });

  it("keeps bundle deletion successful when storage cleanup fails", async () => {
    const databaseClient = createDatabaseClient();
    const deleteFromStorage = vi.fn(async () => {
      throw new Error("storage delete failed");
    });
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { databaseClient, storagePlugin },
      ),
    ).resolves.toBeUndefined();

    expect(databaseClient.deleteBundleById).toHaveBeenCalledOnce();
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: baseBundle.storageUri,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to delete bundle from storage:",
      expect.any(Error),
    );
  });

  it("can return without waiting for storage cleanup", async () => {
    const databaseClient = createDatabaseClient();
    const deleteFromStorage = vi.fn(
      () => new Promise<{ deleted: true }>(() => undefined),
    );
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { databaseClient, storagePlugin, waitForStorageCleanup: false },
      ),
    ).resolves.toBeUndefined();

    expect(databaseClient.deleteBundleById).toHaveBeenCalledOnce();
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: baseBundle.storageUri,
    });
  });

  it("deletes manifest artifacts individually when metadata is available", async () => {
    const bundleWithManifest: Bundle = {
      ...baseBundle,
      assetBaseStorageUri: "s3://bucket/bundles/bundle-copy-id/files",
      manifestFileHash: "manifest-hash",
      manifestStorageUri: "s3://bucket/bundles/bundle-copy-id/manifest.json",
    };
    const databaseClient = createDatabaseClient(bundleWithManifest);
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            assets: {
              "assets/logo.png": { fileHash: "logo-hash" },
              "index.ios.bundle": { fileHash: "bundle-hash" },
            },
          }),
        );
      }),
    );

    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { databaseClient, storagePlugin },
    );

    expect(deleteFromStorage).toHaveBeenCalledTimes(4);
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: bundleWithManifest.storageUri,
    });
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: bundleWithManifest.manifestStorageUri,
    });
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: "s3://bucket/bundles/bundle-copy-id/files/assets/logo.png",
    });
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: "s3://bucket/bundles/bundle-copy-id/files/index.ios.bundle",
    });
  });

  it("leaves content-addressed assets in place when deleting a bundle", async () => {
    const bundleWithManifest: Bundle = {
      ...baseBundle,
      assetBaseStorageUri: "s3://bucket/assets",
      manifestFileHash: "manifest-hash",
      manifestStorageUri: "s3://bucket/bundles/bundle-copy-id/manifest.json",
    };
    const databaseClient = createDatabaseClient(bundleWithManifest);
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    const fetchManifest = vi.fn();
    vi.stubGlobal("fetch", fetchManifest);

    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { databaseClient, storagePlugin },
    );

    expect(databaseClient.getBundles).toHaveBeenCalledOnce();
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(deleteFromStorage).toHaveBeenCalledTimes(2);
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: bundleWithManifest.storageUri,
    });
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: bundleWithManifest.manifestStorageUri,
    });
    expect(deleteFromStorage).not.toHaveBeenCalledWith({
      storageUri: bundleWithManifest.assetBaseStorageUri,
    });
    expect(deleteFromStorage).not.toHaveBeenCalledWith({
      storageUri: "s3://bucket/assets/sha256/lo/logo-hash.png",
    });
    expect(deleteFromStorage).not.toHaveBeenCalledWith({
      storageUri: "s3://bucket/assets/sha256/bu/bundle-hash.br",
    });
  });

  it("does not treat a legacy asset base URI as an exact object when the manifest is unavailable", async () => {
    const bundleWithManifest: Bundle = {
      ...baseBundle,
      assetBaseStorageUri: "s3://bucket/bundles/bundle-copy-id/files",
      manifestFileHash: "manifest-hash",
      manifestStorageUri: "s3://bucket/bundles/bundle-copy-id/manifest.json",
    };
    const databaseClient = createDatabaseClient(bundleWithManifest);
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("not found", {
          status: 404,
          statusText: "Not Found",
        });
      }),
    );

    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { databaseClient, storagePlugin },
    );

    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: bundleWithManifest.storageUri,
    });
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: bundleWithManifest.manifestStorageUri,
    });
    expect(deleteFromStorage).not.toHaveBeenCalledWith({
      storageUri: bundleWithManifest.assetBaseStorageUri,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load bundle manifest for storage cleanup:",
      expect.any(Error),
    );
  });

  it("throws before database deletion when manifest storage uses an unsupported storage protocol", async () => {
    const databaseClient = createDatabaseClient({
      ...baseBundle,
      manifestStorageUri: "r2://bucket/bundle/manifest.json",
    });
    const storagePlugin = createStoragePlugin("s3");

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { databaseClient, storagePlugin },
      ),
    ).rejects.toThrow("No storage plugin for protocol: r2");

    expect(databaseClient.deleteBundleById).not.toHaveBeenCalled();
  });
});
