import fs from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";

import type {
  BundlePatchListQuery,
  Bundle,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
  DatabasePluginCore,
  DatabasePluginRuntime,
  NodeStoragePlugin,
  NodeStorageProfile,
} from "@hot-updater/plugin-core";
import {
  createDatabasePlugin as createDatabaseRuntimePlugin,
  splitDatabaseBundle,
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

const getPatchId = (patch: DatabaseBundlePatch): string =>
  `${patch.bundleId}:${patch.baseBundleId}`;

const matchesBundlePatchWhere = (
  patch: DatabaseBundlePatch,
  where: BundlePatchListQuery["where"],
) => {
  if (!where) return true;
  return (
    (where.bundleId === undefined || patch.bundleId === where.bundleId) &&
    (where.baseBundleId === undefined ||
      patch.baseBundleId === where.baseBundleId) &&
    (where.bundleIdIn === undefined ||
      where.bundleIdIn.includes(patch.bundleId)) &&
    (where.baseBundleIdIn === undefined ||
      where.baseBundleIdIn.includes(patch.baseBundleId))
  );
};

const createDatabaseRuntime = (
  initialBundles: Map<string, Bundle>,
): DatabasePluginRuntime => {
  const bundleRecords = new Map<string, DatabaseBundleRecord>();
  const bundlePatches = new Map<string, DatabaseBundlePatch>();

  for (const bundle of initialBundles.values()) {
    const split = splitDatabaseBundle(bundle);
    bundleRecords.set(bundle.id, split.bundle);
    for (const patch of split.patches) {
      bundlePatches.set(getPatchId(patch), patch);
    }
  }

  return createDatabaseRuntimePlugin({
    name: "mockDatabase",
    connect: (): DatabasePluginCore => ({
      bundles: {
        async delete({ bundleId }) {
          bundleRecords.delete(bundleId);
        },
        async getById({ bundleId }) {
          return bundleRecords.get(bundleId) ?? null;
        },
        async insert({ bundle }) {
          bundleRecords.set(bundle.id, bundle);
        },
        async findMany({ window }) {
          const bundles = Array.from(bundleRecords.values());
          return bundles.slice(window.offset, window.offset + window.limit);
        },
        async count() {
          return bundleRecords.size;
        },
        async update({ bundleId, patch }) {
          const bundle = bundleRecords.get(bundleId);
          if (!bundle) return;
          bundleRecords.set(bundleId, { ...bundle, ...patch });
        },
      },
      bundlePatches: {
        async getById({ patchId }) {
          return bundlePatches.get(patchId) ?? null;
        },
        async insert({ patch }) {
          bundlePatches.set(getPatchId(patch), {
            ...patch,
            id: getPatchId(patch),
          });
        },
        async findMany({ where, window }) {
          return Array.from(bundlePatches.values())
            .filter((patch) => matchesBundlePatchWhere(patch, where))
            .slice(window.offset, window.offset + window.limit);
        },
        async count({ where }) {
          return Array.from(bundlePatches.values()).filter((patch) =>
            matchesBundlePatchWhere(patch, where),
          ).length;
        },
        async update({ patchId, patch }) {
          const current = bundlePatches.get(patchId);
          if (current) {
            bundlePatches.set(patchId, { ...current, ...patch, id: patchId });
          }
        },
        async delete({ patchId }) {
          bundlePatches.delete(patchId);
        },
      },
    }),
  })(undefined);
};

const createStoragePlugin = (
  upload: NodeStorageProfile["upload"],
): NodeStoragePlugin => ({
  name: "mockStorage",
  supportedProtocol: "s3",
  profiles: {
    node: {
      async delete() {},
      async downloadFile(storageUri, filePath) {
        const storageUrl = new URL(storageUri);
        const response = await fetch(
          `https://assets.example.com${storageUrl.pathname}`,
        );
        await fs.writeFile(
          filePath,
          new Uint8Array(await response.arrayBuffer()),
        );
      },
      async exists() {
        return false;
      },
      upload,
    },
  },
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
    const upload = vi.fn<NodeStorageProfile["upload"]>(
      async (key, filePath) => ({
        storageUri: `s3://test-bucket/${key}/${filePath.split("/").pop()}`,
      }),
    );

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

        if (url.endsWith(`${baseBundle.id}/files/index.ios.bundle.br`)) {
          return new Response(brotliCompressSync(new Uint8Array([1, 2, 3])));
        }

        if (url.endsWith(`${baseBundle.id}/files/index.ios.bundle`)) {
          return new Response(new Uint8Array([1, 2, 3]));
        }

        if (url.endsWith(`${targetBundle.id}/files/index.ios.bundle.br`)) {
          return new Response(brotliCompressSync(new Uint8Array([1, 9, 3])));
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
          databasePlugin: createDatabaseRuntime(bundles),
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
      expect(updatedBundle.patches).toEqual([
        {
          baseBundleId: baseBundle.id,
          baseFileHash: "hash-old",
          patchFileHash: updatedBundle.patchFileHash,
          patchStorageUri: updatedBundle.patchStorageUri,
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects ambiguous Hermes bundle assets in manifests", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001");
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002");
    const bundles = new Map([
      [baseBundle.id, baseBundle],
      [targetBundle.id, targetBundle],
    ]);
    const upload = vi.fn<NodeStorageProfile["upload"]>(
      async (key, filePath) => ({
        storageUri: `s3://test-bucket/${key}/${filePath.split("/").pop()}`,
      }),
    );

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
                "secondary.ios.bundle": {
                  fileHash: "hash-secondary-old",
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
                "secondary.ios.bundle": {
                  fileHash: "hash-secondary-new",
                },
              },
              bundleId: targetBundle.id,
            }),
          );
        }

        return new Response("not found", { status: 404 });
      }),
    );

    try {
      await expect(
        createBundleDiff(
          {
            baseBundleId: baseBundle.id,
            bundleId: targetBundle.id,
          },
          {
            databasePlugin: createDatabaseRuntime(bundles),
            storagePlugin: createStoragePlugin(upload),
          },
        ),
      ).rejects.toThrow("Expected exactly one Hermes bundle asset in manifest");
      expect(upload).not.toHaveBeenCalled();
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
      patches: [
        {
          baseBundleId: primaryBaseBundle.id,
          baseFileHash: "hash-primary-old",
          patchFileHash: "hash-primary-patch",
          patchStorageUri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
        },
      ],
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
    const upload = vi.fn<NodeStorageProfile["upload"]>(
      async (key, filePath) => ({
        storageUri: `s3://test-bucket/${key}/${filePath.split("/").pop()}`,
      }),
    );

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

        if (
          url.endsWith(`${secondaryBaseBundle.id}/files/index.ios.bundle.br`)
        ) {
          return new Response(brotliCompressSync(new Uint8Array([1, 2, 3])));
        }

        if (url.endsWith(`${secondaryBaseBundle.id}/files/index.ios.bundle`)) {
          return new Response(new Uint8Array([1, 2, 3]));
        }

        if (url.endsWith(`${targetBundle.id}/files/index.ios.bundle.br`)) {
          return new Response(brotliCompressSync(new Uint8Array([1, 4, 3])));
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
          databasePlugin: createDatabaseRuntime(bundles),
          storagePlugin: createStoragePlugin(upload),
        },
        {
          makePrimary: false,
        },
      );

      expect(updatedBundle.patchBaseBundleId).toBe(primaryBaseBundle.id);
      expect(updatedBundle.patches).toMatchObject([
        {
          baseBundleId: primaryBaseBundle.id,
          baseFileHash: "hash-primary-old",
          patchFileHash: "hash-primary-patch",
          patchStorageUri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
        },
        {
          baseBundleId: secondaryBaseBundle.id,
          baseFileHash: "hash-secondary-old",
          patchFileHash: expect.any(String),
          patchStorageUri: expect.stringContaining(
            `${targetBundle.id}/patches/${secondaryBaseBundle.id}`,
          ),
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
