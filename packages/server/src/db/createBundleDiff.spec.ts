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

const createBundle = (id: string, overrides: Partial<Bundle> = {}): Bundle => ({
  channel: "production",
  enabled: true,
  fileHash: `${id}-file-hash`,
  fingerprintHash: null,
  gitCommitHash: null,
  id,
  message: id,
  assetBaseStorageUri: `s3://test-bucket/releases/${id}/files`,
  manifestStorageUri: `s3://test-bucket/releases/${id}/manifest.json`,
  metadata: {},
  platform: "ios",
  shouldForceUpdate: false,
  storageUri: `s3://test-bucket/releases/${id}/bundle.zip`,
  targetAppVersion: "1.0.0",
  ...overrides,
});

const createDatabasePlugin = (
  bundles: Map<string, Bundle>,
): DatabasePlugin => ({
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
});

const createStoragePlugin = (
  upload: StoragePlugin["upload"],
): StoragePlugin => ({
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
});

describe("createBundleDiff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads a Hermes patch and stores patch metadata on the target bundle", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001", {
      message: "base",
    });
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002", {
      message: "target",
    });
    const bundles = new Map([
      [baseBundle.id, baseBundle],
      [targetBundle.id, targetBundle],
    ]);
    const upload = vi.fn<StoragePlugin["upload"]>(async (key, filePath) => ({
      storageUri: `s3://test-bucket/${key}/${filePath.split("/").pop()}`,
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | URL | string) => {
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
          databasePlugin: createDatabasePlugin(bundles),
          storagePlugin: createStoragePlugin(upload),
        },
      );

      expect(upload).toHaveBeenCalledOnce();
      expect(updatedBundle).toMatchObject({
        patchBaseBundleId: baseBundle.id,
        patchBaseFileHash: "hash-old",
      });
      expect(updatedBundle.patchFileHash).toMatch(/[a-f0-9]{64}/);
      expect(updatedBundle.patchStorageUri).toContain(
        `${targetBundle.id}/patches/${baseBundle.id}`,
      );
      expect(updatedBundle.metadata?.patches).toEqual({
        [baseBundle.id]: {
          base_file_hash: "hash-old",
          patch_file_hash: updatedBundle.patchFileHash,
          patch_storage_uri: updatedBundle.patchStorageUri,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("appends additional patch bases without replacing the primary patch when requested", async () => {
    const primaryBaseBundle = createBundle(
      "00000000-0000-0000-0000-000000000001",
    );
    const secondaryBaseBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
    );
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000003", {
      metadata: {
        patches: {
          [primaryBaseBundle.id]: {
            base_file_hash: "hash-primary-old",
            patch_file_hash: "hash-primary-patch",
            patch_storage_uri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
          },
        },
      },
      patchBaseBundleId: primaryBaseBundle.id,
      patchBaseFileHash: "hash-primary-old",
      patchFileHash: "hash-primary-patch",
      patchStorageUri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
    });
    const bundles = new Map([
      [primaryBaseBundle.id, primaryBaseBundle],
      [secondaryBaseBundle.id, secondaryBaseBundle],
      [targetBundle.id, targetBundle],
    ]);
    const upload = vi.fn<StoragePlugin["upload"]>(async (key, filePath) => ({
      storageUri: `s3://test-bucket/${key}/${filePath.split("/").pop()}`,
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | URL | string) => {
        const url = String(input);

        if (url.endsWith(`${secondaryBaseBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "hash-secondary-old",
                },
              },
              bundleId: secondaryBaseBundle.id,
            }),
          );
        }

        if (url.endsWith(`${targetBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "hash-target-new",
                },
              },
              bundleId: targetBundle.id,
            }),
          );
        }

        if (url.endsWith(`${secondaryBaseBundle.id}/files/index.ios.bundle`)) {
          return new Response(new Uint8Array([1, 2, 3]));
        }

        if (url.endsWith(`${targetBundle.id}/files/index.ios.bundle`)) {
          return new Response(new Uint8Array([1, 4, 3]));
        }

        return new Response("not found", { status: 404 });
      }),
    );

    try {
      const updatedBundle = await createBundleDiff(
        {
          baseBundleId: secondaryBaseBundle.id,
          bundleId: targetBundle.id,
        },
        {
          databasePlugin: createDatabasePlugin(bundles),
          storagePlugin: createStoragePlugin(upload),
        },
        {
          makePrimary: false,
        },
      );

      expect(updatedBundle.patchBaseBundleId).toBe(primaryBaseBundle.id);
      expect(updatedBundle.metadata?.patches).toMatchObject({
        [primaryBaseBundle.id]: {
          base_file_hash: "hash-primary-old",
          patch_file_hash: "hash-primary-patch",
          patch_storage_uri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
        },
        [secondaryBaseBundle.id]: {
          base_file_hash: "hash-secondary-old",
          patch_file_hash: expect.any(String),
          patch_storage_uri: expect.stringContaining(
            `${targetBundle.id}/patches/${secondaryBaseBundle.id}`,
          ),
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
