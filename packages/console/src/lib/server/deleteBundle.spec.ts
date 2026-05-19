// @vitest-environment node

import fs from "node:fs/promises";
import path from "node:path";

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

  it("garbage collects unreferenced content-addressed assets when deleting a bundle", async () => {
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith("/manifest.json")) {
          return new Response(
            JSON.stringify({
              assets: {
                "assets/logo.png": { fileHash: "logo-hash" },
                "index.ios.bundle": { fileHash: "bundle-hash" },
              },
            }),
          );
        }

        return new Response(
          JSON.stringify({
            references: {
              [bundleWithManifest.id]: {
                assetPath: "assets/logo.png",
                bundleId: bundleWithManifest.id,
              },
            },
            storageUri: "s3://bucket/assets/sha256/lo/logo-hash.png",
            version: 1,
          }),
        );
      }),
    );

    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { databasePlugin, storagePlugin },
    );

    expect(databasePlugin.getBundles).not.toHaveBeenCalled();
    expect(deleteFromStorage).toHaveBeenCalledTimes(6);
    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.storageUri,
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.manifestStorageUri,
    );
    expect(deleteFromStorage).not.toHaveBeenCalledWith(
      bundleWithManifest.assetBaseStorageUri,
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      "s3://bucket/assets/sha256/lo/logo-hash.png",
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      "s3://bucket/assets/refs/sha256/lo/logo-hash.png.json",
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      "s3://bucket/assets/sha256/bu/bundle-hash.br",
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      "s3://bucket/assets/refs/sha256/bu/bundle-hash.br.json",
    );
  });

  it("keeps content-addressed assets referenced by remaining bundles", async () => {
    const bundleWithManifest: Bundle = {
      ...baseBundle,
      assetBaseStorageUri: "s3://bucket/assets",
      manifestFileHash: "manifest-hash",
      manifestStorageUri: "s3://bucket/bundles/bundle-copy-id/manifest.json",
    };
    const databasePlugin = createDatabasePlugin(bundleWithManifest);
    const deleteFromStorage = vi.fn();
    const uploadedRefs = new Map<string, unknown>();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
      upload: vi.fn(async (key: string, filePath: string) => {
        uploadedRefs.set(key, JSON.parse(await fs.readFile(filePath, "utf8")));
        return {
          storageUri: `s3://bucket/${key}/${path.basename(filePath)}`,
        };
      }),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith("/manifest.json")) {
          return new Response(
            JSON.stringify({
              assets: {
                "assets/logo.png": { fileHash: "logo-hash" },
                "index.ios.bundle": { fileHash: "bundle-hash" },
              },
            }),
          );
        }

        if (String(url).endsWith("/refs/sha256/lo/logo-hash.png.json")) {
          return new Response(
            JSON.stringify({
              references: {
                [bundleWithManifest.id]: {
                  assetPath: "assets/logo.png",
                  bundleId: bundleWithManifest.id,
                },
                "0195a408-8f13-7d9b-8df4-remainingbundle": {
                  assetPath: "assets/logo.png",
                  bundleId: "0195a408-8f13-7d9b-8df4-remainingbundle",
                },
              },
              storageUri: "s3://bucket/assets/sha256/lo/logo-hash.png",
              version: 1,
            }),
          );
        }

        return new Response(
          JSON.stringify({
            references: {
              [bundleWithManifest.id]: {
                assetPath: "index.ios.bundle",
                bundleId: bundleWithManifest.id,
              },
            },
            storageUri: "s3://bucket/assets/sha256/bu/bundle-hash.br",
            version: 1,
          }),
        );
      }),
    );

    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { databasePlugin, storagePlugin },
    );

    expect(databasePlugin.getBundles).not.toHaveBeenCalled();
    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.storageUri,
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      bundleWithManifest.manifestStorageUri,
    );
    expect(deleteFromStorage).not.toHaveBeenCalledWith(
      "s3://bucket/assets/sha256/lo/logo-hash.png",
    );
    expect(deleteFromStorage).not.toHaveBeenCalledWith(
      "s3://bucket/assets/refs/sha256/lo/logo-hash.png.json",
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      "s3://bucket/assets/sha256/bu/bundle-hash.br",
    );
    expect(deleteFromStorage).toHaveBeenCalledWith(
      "s3://bucket/assets/refs/sha256/bu/bundle-hash.br.json",
    );
    expect(uploadedRefs.get("assets/refs/sha256/lo")).toEqual({
      references: {
        "0195a408-8f13-7d9b-8df4-remainingbundle": {
          assetPath: "assets/logo.png",
          bundleId: "0195a408-8f13-7d9b-8df4-remainingbundle",
        },
      },
      storageUri: "s3://bucket/assets/sha256/lo/logo-hash.png",
      version: 1,
    });
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
