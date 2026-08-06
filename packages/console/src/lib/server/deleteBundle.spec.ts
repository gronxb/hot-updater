// @vitest-environment node

import fs from "node:fs/promises";

import type {
  Bundle,
  DatabaseClient,
  NodeStoragePlugin,
  NodeStorageProfile,
  RuntimeStorageProfile,
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

function createDatabaseClient(bundle: Bundle | null = baseBundle) {
  return {
    getChannels: vi.fn(),
    getBundleById: vi.fn(async () => bundle),
    getBundles: vi.fn(),
    getUpdateInfo: vi.fn(),
    updateBundleById: vi.fn(),
    insertBundle: vi.fn(),
    deleteBundleById: vi.fn(),
    mutate: vi.fn(),
  } satisfies DatabaseClient;
}

function createStoragePlugin(
  supportedProtocol = "s3",
  overrides?: Partial<NodeStorageProfile> & Partial<RuntimeStorageProfile>,
) {
  const getDownloadUrl =
    overrides?.getDownloadUrl ??
    vi.fn(async (storageUri: string) => {
      const storageUrl = new URL(storageUri);
      return {
        fileUrl: `https://assets.example.com${storageUrl.pathname}`,
      };
    });
  const storagePlugin = {
    name: "mockStorage",
    supportedProtocol,
    profiles: {
      node: {
        upload: overrides?.upload ?? vi.fn(),
        delete: overrides?.delete ?? vi.fn(),
        exists: overrides?.exists ?? vi.fn(async () => false),
        downloadFile:
          overrides?.downloadFile ??
          vi.fn(async (storageUri: string, filePath: string) => {
            const { fileUrl } = await getDownloadUrl(storageUri);
            const response = await fetch(fileUrl);
            await fs.writeFile(
              filePath,
              new Uint8Array(await response.arrayBuffer()),
            );
          }),
      },
      runtime: {
        getDownloadUrl,
        readText: overrides?.readText ?? vi.fn(async () => null),
      },
    },
  };

  return storagePlugin satisfies NodeStoragePlugin;
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

    expect(databaseClient.getBundleById).toHaveBeenCalledWith(baseBundle.id);
    expect(databaseClient.deleteBundleById).toHaveBeenCalledWith(baseBundle.id);
    expect(deleteFromStorage).toHaveBeenCalledWith(baseBundle.storageUri);

    expect(
      databaseClient.deleteBundleById.mock.invocationCallOrder[0],
    ).toBeLessThan(deleteFromStorage.mock.invocationCallOrder[0]);
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
    expect(storagePlugin.profiles.node.delete).not.toHaveBeenCalled();
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
    expect(deleteFromStorage).toHaveBeenCalledWith(baseBundle.storageUri);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to delete bundle from storage:",
      expect.any(Error),
    );
  });

  it("can return without waiting for storage cleanup", async () => {
    const databaseClient = createDatabaseClient();
    const deleteFromStorage = vi.fn(() => new Promise<void>(() => undefined));
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
    expect(deleteFromStorage).toHaveBeenCalledWith(baseBundle.storageUri);
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
      getDownloadUrl: vi.fn(async (storageUri) => ({
        fileUrl:
          storageUri === bundleWithManifest.manifestStorageUri
            ? "https://cdn.example.com/manifest.json"
            : "https://cdn.example.com/unknown",
      })),
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

    expect(databaseClient.getBundles).not.toHaveBeenCalled();
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
    const databaseClient = createDatabaseClient(bundleWithManifest);
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
      getDownloadUrl: vi.fn(async () => ({
        fileUrl: "https://cdn.example.com/manifest.json",
      })),
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
