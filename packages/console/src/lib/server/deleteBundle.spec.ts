// @vitest-environment node

import fs from "node:fs/promises";

import type {
  Bundle,
  DatabasePlugin,
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

function createDatabasePlugin(bundle: Bundle | null = baseBundle) {
  return {
    name: "mockDatabase",
    getChannels: vi.fn(),
    getBundleById: vi.fn(async () => bundle),
    getBundles: vi.fn(),
    updateBundle: vi.fn(),
    appendBundle: vi.fn(),
    commitBundle: vi.fn(),
    deleteBundle: vi.fn(),
  } satisfies DatabasePlugin;
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
    expect(storagePlugin.profiles.node.delete).not.toHaveBeenCalled();
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
              "index.js": { fileHash: "bundle-hash" },
            },
          }),
        );
      }),
    );

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
      "s3://bucket/bundles/bundle-copy-id/files/index.js",
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

  it("throws before database deletion when manifest metadata uses an unsupported storage protocol", async () => {
    const databasePlugin = createDatabasePlugin({
      ...baseBundle,
      metadata: {
        manifest_storage_uri: "r2://bucket/bundle/manifest.json",
      },
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
