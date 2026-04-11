import type {
  Bundle,
  DatabasePlugin,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/bsdiff", () => ({
  hdiff: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
}));

import { createBundleDiff } from "./createBundleDiff";

describe("createBundleDiff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads a Hermes patch and stores stacked diff metadata on the target bundle", async () => {
    const baseBundle: Bundle = {
      channel: "production",
      enabled: true,
      fileHash: "base-file-hash",
      fingerprintHash: null,
      gitCommitHash: null,
      id: "00000000-0000-0000-0000-000000000001",
      message: "base",
      metadata: {
        asset_base_storage_uri:
          "s3://test-bucket/releases/00000000-0000-0000-0000-000000000001/files",
        manifest_storage_uri:
          "s3://test-bucket/releases/00000000-0000-0000-0000-000000000001/manifest.json",
      },
      platform: "ios",
      shouldForceUpdate: false,
      storageUri:
        "s3://test-bucket/releases/00000000-0000-0000-0000-000000000001/bundle.zip",
      targetAppVersion: "1.0.0",
    };
    const targetBundle: Bundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000002",
      message: "target",
      metadata: {
        asset_base_storage_uri:
          "s3://test-bucket/releases/00000000-0000-0000-0000-000000000002/files",
        manifest_storage_uri:
          "s3://test-bucket/releases/00000000-0000-0000-0000-000000000002/manifest.json",
      },
      storageUri:
        "s3://test-bucket/releases/00000000-0000-0000-0000-000000000002/bundle.zip",
    };

    const bundles = new Map([
      [baseBundle.id, baseBundle],
      [targetBundle.id, targetBundle],
    ]);
    const upload = vi.fn<StoragePlugin["upload"]>(async (key, filePath) => ({
      storageUri: `s3://test-bucket/${key}/${filePath.split("/").pop()}`,
    }));
    const databasePlugin: DatabasePlugin = {
      name: "mockDatabase",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById(bundleId) {
        return bundles.get(bundleId) ?? null;
      },
      async getBundles() {
        return {
          data: Array.from(bundles.values()),
          pagination: {
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            total: bundles.size,
            totalPages: 1,
          },
        };
      },
      async getChannels() {
        return ["production"];
      },
      async onUnmount() {},
      async updateBundle(bundleId, nextBundle) {
        const currentBundle = bundles.get(bundleId);
        if (!currentBundle) {
          return;
        }
        bundles.set(bundleId, {
          ...currentBundle,
          ...nextBundle,
          metadata: {
            ...currentBundle.metadata,
            ...nextBundle.metadata,
          },
        });
      },
    };
    const storagePlugin: StoragePlugin = {
      name: "mockStorage",
      supportedProtocol: "s3",
      async delete() {},
      async getDownloadUrl(storageUri) {
        const storageUrl = new URL(storageUri);
        return {
          fileUrl: `https://assets.example.com${storageUrl.pathname}`,
        };
      },
      upload,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.endsWith(`${baseBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "hash-old",
                },
              },
              bundleId: baseBundle.id,
            }),
          );
        }

        if (url.endsWith(`${targetBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "hash-new",
                },
              },
              bundleId: targetBundle.id,
            }),
          );
        }

        if (url.endsWith(`${baseBundle.id}/files/index.ios.bundle`)) {
          return new Response(new Uint8Array([1, 2, 3]));
        }

        if (url.endsWith(`${targetBundle.id}/files/index.ios.bundle`)) {
          return new Response(new Uint8Array([1, 9, 3]));
        }

        return new Response("not found", { status: 404 });
      }),
    );

    try {
      const updatedBundle = await createBundleDiff(
        {
          baseBundleId: baseBundle.id,
          bundleId: targetBundle.id,
        },
        {
          databasePlugin,
          storagePlugin,
        },
      );

      expect(upload).toHaveBeenCalledOnce();
      expect(updatedBundle.metadata).toMatchObject({
        diff_base_bundle_id: baseBundle.id,
        hbc_patch_algorithm: "bsdiff",
        hbc_patch_asset_path: "index.ios.bundle",
        hbc_patch_base_file_hash: "hash-old",
      });
      expect(updatedBundle.metadata?.hbc_patch_file_hash).toMatch(
        /[a-f0-9]{64}/,
      );
      expect(updatedBundle.metadata?.hbc_patch_storage_uri).toContain(
        `${targetBundle.id}/patches/${baseBundle.id}`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
