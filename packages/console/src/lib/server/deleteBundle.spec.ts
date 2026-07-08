// @vitest-environment node

import type {
  Bundle,
  DatabasePlugin,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteBundle } from "./deleteBundle";

const baseBundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "stable",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "abc123",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
};

function createDatabasePlugin(
  bundle: Bundle | null = baseBundle,
  remainingBundles: Bundle[] = [],
) {
  return {
    name: "mockDatabase",
    getChannels: vi.fn(),
    getBundleById: vi.fn(async () => bundle),
    getBundles: vi.fn(async () => ({
      data: remainingBundles,
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: remainingBundles.length,
        totalPages: remainingBundles.length > 0 ? 1 : 0,
      },
    })),
    updateBundle: vi.fn(),
    appendBundle: vi.fn(),
    commitBundle: vi.fn(),
    deleteBundle: vi.fn(),
  } satisfies DatabasePlugin;
}

function createStoragePlugin(
  supportedProtocol = "s3",
  overrides?: Partial<StoragePlugin>,
) {
  return {
    name: "mockStorage",
    supportedProtocol,
    delete: overrides?.delete ?? vi.fn(),
    exists: overrides?.exists ?? vi.fn(async () => false),
    getDownloadUrl:
      overrides?.getDownloadUrl ??
      vi.fn(async (storageUri: string) => {
        const storageUrl = new URL(storageUri);
        return {
          fileUrl: `https://assets.example.com${storageUrl.pathname}`,
        };
      }),
    readText: overrides?.readText ?? vi.fn(async () => null),
    upload: overrides?.upload ?? vi.fn(),
  } satisfies StoragePlugin;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteBundle", () => {
  it("deletes the bundle from database and storage", async () => {
    const databasePlugin = createDatabasePlugin();
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundle(
      { bundleId: baseBundle.id },
      { databasePlugin, storagePlugin },
    );

    expect(databasePlugin.getBundleById).toHaveBeenCalledWith(baseBundle.id);
    expect(databasePlugin.deleteBundle).toHaveBeenCalledWith(baseBundle);
    expect(databasePlugin.commitBundle).toHaveBeenCalledOnce();
    expect(deleteFromStorage).toHaveBeenCalledWith(baseBundle.storageUri);

    expect(
      databasePlugin.deleteBundle.mock.invocationCallOrder[0],
    ).toBeLessThan(databasePlugin.commitBundle.mock.invocationCallOrder[0]);
    expect(
      databasePlugin.commitBundle.mock.invocationCallOrder[0],
    ).toBeLessThan(deleteFromStorage.mock.invocationCallOrder[0]);
  });

  it("skips storage deletion for http urls", async () => {
    const databasePlugin = createDatabasePlugin({
      ...baseBundle,
      storageUri: "https://cdn.example.com/bundle.zip",
    });
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundle(
      { bundleId: baseBundle.id },
      { databasePlugin, storagePlugin },
    );

    expect(databasePlugin.deleteBundle).toHaveBeenCalledOnce();
    expect(databasePlugin.commitBundle).toHaveBeenCalledOnce();
    expect(deleteFromStorage).not.toHaveBeenCalled();
  });

  it("throws before database deletion when the storage protocol is unsupported", async () => {
    const databasePlugin = createDatabasePlugin({
      ...baseBundle,
      storageUri: "r2://bucket/bundle.zip",
    });
    const storagePlugin = createStoragePlugin("s3");

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { databasePlugin, storagePlugin },
      ),
    ).rejects.toThrow("No storage plugin for protocol: r2");

    expect(databasePlugin.deleteBundle).not.toHaveBeenCalled();
    expect(databasePlugin.commitBundle).not.toHaveBeenCalled();
    expect(storagePlugin.delete).not.toHaveBeenCalled();
  });

  it("throws before database deletion when storage delete is unsupported", async () => {
    const databasePlugin = createDatabasePlugin();
    const storagePlugin = {
      name: "readOnlyStorage",
      supportedProtocol: "s3",
      readText: vi.fn(async () => null),
    } satisfies StoragePlugin;

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { databasePlugin, storagePlugin },
      ),
    ).rejects.toThrow(
      'readOnlyStorage does not implement the delete storage operation for protocol "s3".',
    );

    expect(databasePlugin.deleteBundle).not.toHaveBeenCalled();
    expect(databasePlugin.commitBundle).not.toHaveBeenCalled();
  });

  it("keeps bundle deletion successful when storage cleanup fails", async () => {
    const databasePlugin = createDatabasePlugin();
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
        { databasePlugin, storagePlugin },
      ),
    ).resolves.toBeUndefined();

    expect(databasePlugin.deleteBundle).toHaveBeenCalledOnce();
    expect(databasePlugin.commitBundle).toHaveBeenCalledOnce();
    expect(deleteFromStorage).toHaveBeenCalledWith(baseBundle.storageUri);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to delete bundle from storage:",
      expect.any(Error),
    );
  });

  it("can return without waiting for storage cleanup", async () => {
    const databasePlugin = createDatabasePlugin();
    const deleteFromStorage = vi.fn(() => new Promise<void>(() => undefined));
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { databasePlugin, storagePlugin, waitForStorageCleanup: false },
      ),
    ).resolves.toBeUndefined();

    expect(databasePlugin.deleteBundle).toHaveBeenCalledOnce();
    expect(databasePlugin.commitBundle).toHaveBeenCalledOnce();
    expect(deleteFromStorage).toHaveBeenCalledWith(baseBundle.storageUri);
  });

  it("deletes manifest artifacts individually when metadata is available", async () => {
    const bundleWithManifest: Bundle = {
      ...baseBundle,
      assetBaseStorageUri: "s3://bucket/bundles/bundle-copy-id/files",
      manifestFileHash: "manifest-hash",
      manifestStorageUri: "s3://bucket/bundles/bundle-copy-id/manifest.json",
    };
    const databasePlugin = createDatabasePlugin(bundleWithManifest);
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
      readText: vi.fn(async () =>
        JSON.stringify({
          assets: {
            "assets/logo.png": { fileHash: "logo-hash" },
            "index.ios.bundle": { fileHash: "bundle-hash" },
          },
        }),
      ),
    });

    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { databasePlugin, storagePlugin },
    );

    expect(deleteFromStorage).toHaveBeenCalledTimes(4);
    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.storageUri,
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.manifestStorageUri,
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      "s3://bucket/bundles/bundle-copy-id/files/assets/logo.png",
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      "s3://bucket/bundles/bundle-copy-id/files/index.ios.bundle",
    );
  });

  it("keeps storage artifacts that are still referenced by another bundle", async () => {
    const bundleWithManifest: Bundle = {
      ...baseBundle,
      manifestStorageUri: "s3://bucket/bundle/manifest.json",
    };
    const copiedBundle: Bundle = {
      ...bundleWithManifest,
      id: "0195a408-8f13-7d9b-8df4-copiedbundle",
      channel: "production",
    };
    const databasePlugin = createDatabasePlugin(bundleWithManifest, [
      copiedBundle,
    ]);
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { databasePlugin, storagePlugin },
    );

    expect(databasePlugin.deleteBundle).toHaveBeenCalledWith(
      bundleWithManifest,
    );
    expect(databasePlugin.commitBundle).toHaveBeenCalledOnce();
    expect(deleteFromStorage).not.toHaveBeenCalled();
  });

  it("leaves content-addressed assets in place when deleting a bundle", async () => {
    const bundleWithManifest: Bundle = {
      ...baseBundle,
      assetBaseStorageUri: "s3://bucket/assets",
      manifestFileHash: "manifest-hash",
      manifestStorageUri: "s3://bucket/bundles/bundle-copy-id/manifest.json",
    };
    const databasePlugin = createDatabasePlugin(bundleWithManifest);
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    const fetchManifest = vi.fn();
    vi.stubGlobal("fetch", fetchManifest);

    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { databasePlugin, storagePlugin },
    );

    expect(fetchManifest).not.toHaveBeenCalled();
    expect(deleteFromStorage).toHaveBeenCalledTimes(2);
    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.storageUri,
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.manifestStorageUri,
    );
    expect(deleteFromStorage).not.toHaveBeenCalledWith(
      bundleWithManifest.assetBaseStorageUri,
    );
    expect(deleteFromStorage).not.toHaveBeenCalledWith(
      "s3://bucket/assets/sha256/lo/logo-hash.png",
    );
    expect(deleteFromStorage).not.toHaveBeenCalledWith(
      "s3://bucket/assets/sha256/bu/bundle-hash.br",
    );
  });

  it("falls back to deleting the asset base uri when manifest cleanup lookup fails", async () => {
    const bundleWithManifest: Bundle = {
      ...baseBundle,
      assetBaseStorageUri: "s3://bucket/bundles/bundle-copy-id/files",
      manifestFileHash: "manifest-hash",
      manifestStorageUri: "s3://bucket/bundles/bundle-copy-id/manifest.json",
    };
    const databasePlugin = createDatabasePlugin(bundleWithManifest);
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
      readText: vi.fn(async () => {
        throw new Error("Failed to read manifest");
      }),
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { databasePlugin, storagePlugin },
    );

    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.storageUri,
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.manifestStorageUri,
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.assetBaseStorageUri,
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load bundle manifest for storage cleanup:",
      expect.any(Error),
    );
  });

  it("falls back to deleting the asset base uri when manifest readText is unsupported", async () => {
    const bundleWithManifest: Bundle = {
      ...baseBundle,
      assetBaseStorageUri: "s3://bucket/bundles/bundle-copy-id/files",
      manifestFileHash: "manifest-hash",
      manifestStorageUri: "s3://bucket/bundles/bundle-copy-id/manifest.json",
    };
    const databasePlugin = createDatabasePlugin(bundleWithManifest);
    const deleteFromStorage = vi.fn();
    const storagePlugin = {
      name: "deleteOnlyStorage",
      supportedProtocol: "s3",
      delete: deleteFromStorage,
    } satisfies StoragePlugin;
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { databasePlugin, storagePlugin },
    );

    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.assetBaseStorageUri,
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load bundle manifest for storage cleanup:",
      expect.objectContaining({
        message:
          'deleteOnlyStorage does not implement the readText storage operation for protocol "s3".',
      }),
    );
  });

  it("throws before database deletion when manifest storage uses an unsupported storage protocol", async () => {
    const databasePlugin = createDatabasePlugin({
      ...baseBundle,
      manifestStorageUri: "r2://bucket/bundle/manifest.json",
    });
    const storagePlugin = createStoragePlugin("s3");

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { databasePlugin, storagePlugin },
      ),
    ).rejects.toThrow("No storage plugin for protocol: r2");

    expect(databasePlugin.deleteBundle).not.toHaveBeenCalled();
    expect(databasePlugin.commitBundle).not.toHaveBeenCalled();
  });
});
