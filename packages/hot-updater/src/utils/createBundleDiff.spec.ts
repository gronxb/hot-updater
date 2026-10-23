import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";

import type {
  Bundle,
  StorageAdapter,
  StorageAdapterWith,
} from "@hot-updater/plugin-core";
import {
  createStorageAdapter as createCoreStorageAdapter,
  rowToBundle,
  createMemoryAdapter,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/bsdiff", () => ({
  hdiff: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
}));

import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";

import { createBundleDiff } from "./createBundleDiff";

const createBundle = (id: string, overrides: Partial<Bundle> = {}): Bundle => ({
  gitCommitHash: null,
  id,
  assetBaseStorageUri: "s3://test-bucket/releases/assets",
  manifestStorageUri: `s3://test-bucket/releases/bundles/${id}/manifest.json`,
  metadata: {},
  platform: "ios",
  manifestFileHash: `${id}-manifest-hash`,
  ...overrides,
});

type Core = ReturnType<typeof createHotUpdater>["core"];

/** Core's API on an in-memory database holding `bundles`, each deployed disabled. */
const createCore = async (bundles: readonly Bundle[]): Promise<Core> => {
  const { core } = createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    storage: createReleaseCatalogTestStorage(),
    clientAccess: "public",
  });
  for (const bundle of bundles) {
    await core.deploy([
      {
        bundle,
        release: {
          channel: "production",
          enabled: false,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "*",
        },
      },
    ]);
  }
  return core;
};

/** A stored bundle with its patches, as deploys write it. */
const storedBundle = async (core: Core, id: string) => {
  const detail = await core.getBundle(id);
  return detail === null ? null : rowToBundle(detail.bundle, detail.patches);
};

const createStorageAdapter = (
  put: NonNullable<StorageAdapter["put"]>,
  options: {
    get?: NonNullable<StorageAdapter["get"]>;
    protocol?: string;
  } = {},
): StorageAdapterWith<"get" | "put" | "delete"> =>
  createCoreStorageAdapter({
    name: "mockStorage",
    protocol: options.protocol ?? "s3",
    async delete({ storageUri }) {
      void storageUri;
      return { deleted: true };
    },
    get:
      options.get ??
      (async ({ storageUri }) => {
        const storageUrl = new URL(storageUri);
        const response = await fetch(
          `https://assets.example.com${storageUrl.pathname}`,
        );
        return { response: response.ok ? response : null };
      }),
    put,
  });

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** A Hermes bundle asset as deploy uploads it: Brotli-compressed, content-addressed. */
const createAsset = (bytes: number[]) => {
  const original = new Uint8Array(bytes);
  const compressed = new Uint8Array(brotliCompressSync(original));
  const fileHash = sha256(original);
  const downloadFileHash = sha256(compressed);
  return {
    compressed,
    compressedPath: `/assets/sha256/${downloadFileHash.slice(0, 2)}/${downloadFileHash}.br`,
    manifestEntry: {
      byteSize: original.byteLength,
      downloadByteSize: compressed.byteLength,
      downloadFileHash,
      fileHash,
    },
    original,
    originalPath: `/assets/sha256/${fileHash.slice(0, 2)}/${fileHash}.bundle`,
  };
};

type Asset = ReturnType<typeof createAsset>;

/** Answers the manifests and compressed assets of `base` and `target` over fetch. */
const stubStorageFetch = (
  entries: { bundle: Bundle; asset: Asset; body?: Uint8Array }[],
) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | URL | string) => {
      const url = String(input);
      for (const { bundle, asset, body } of entries) {
        if (url.endsWith(`${bundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: { "index.ios.bundle": asset.manifestEntry },
              bundleId: bundle.id,
            }),
          );
        }
        if (url.endsWith(asset.compressedPath)) {
          return new Response((body ?? asset.compressed) as BodyInit);
        }
      }
      return new Response("not found", { status: 404 });
    }),
  );
};

describe("createBundleDiff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads a Hermes patch and stores patch metadata on the target bundle", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001");
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002");
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const core = await createCore([baseBundle, targetBundle]);
    const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
      async ({ key, body, contentLength }) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(contentLength).toBe(bytes.byteLength);
        return { storageUri: `s3://test-bucket/${key}` };
      },
    );

    stubStorageFetch([
      { bundle: baseBundle, asset: baseAsset },
      { bundle: targetBundle, asset: targetAsset },
    ]);

    try {
      const updatedBundle = await createBundleDiff(
        {
          baseBundleId: baseBundle.id,
          bundleId: targetBundle.id,
        },
        {
          core,
          storageAdapter: createStorageAdapter(upload),
        },
      );

      expect(upload).toHaveBeenCalledOnce();
      await expect(storedBundle(core, targetBundle.id)).resolves.toMatchObject({
        patches: updatedBundle.patches,
      });
      const [patch] = updatedBundle.patches ?? [];
      expect(patch?.baseBundleId).toBe(baseBundle.id);
      expect(patch?.baseFileHash).toBe(baseAsset.manifestEntry.fileHash);
      expect(patch?.byteSize).toBe(4);
      expect(patch?.patchFileHash).toMatch(/[a-f0-9]{64}/);
      expect(patch?.patchStorageUri).toContain(
        `bundles/${targetBundle.id}/patches/${baseBundle.id}/${patch?.patchFileHash}/`,
      );
      expect(updatedBundle.patches).toEqual([
        {
          baseBundleId: baseBundle.id,
          baseFileHash: baseAsset.manifestEntry.fileHash,
          byteSize: 4,
          patchFileHash: patch?.patchFileHash,
          patchStorageUri: patch?.patchStorageUri,
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects ambiguous Hermes bundle assets in manifests", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001");
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002");
    const core = await createCore([baseBundle, targetBundle]);
    const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
      async ({ key }) => ({
        storageUri: `s3://test-bucket/${key}`,
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
            core,
            storageAdapter: createStorageAdapter(upload),
          },
        ),
      ).rejects.toThrow("Expected exactly one Hermes bundle asset in manifest");
      expect(upload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses a matching HTTPS storage adapter before direct fetch", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001", {
      assetBaseStorageUri: "https://storage.example.com/releases/assets",
      manifestStorageUri:
        "https://storage.example.com/releases/base/manifest.json",
    });
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002", {
      assetBaseStorageUri: "https://storage.example.com/releases/assets",
      manifestStorageUri:
        "https://storage.example.com/releases/target/manifest.json",
    });
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const core = await createCore([baseBundle, targetBundle]);
    const responses = new Map<string, string | Uint8Array>([
      [
        baseBundle.manifestStorageUri!,
        JSON.stringify({
          assets: {
            "index.ios.bundle": { fileHash: baseAsset.manifestEntry.fileHash },
          },
          bundleId: baseBundle.id,
        }),
      ],
      [
        targetBundle.manifestStorageUri!,
        JSON.stringify({
          assets: {
            "index.ios.bundle": {
              fileHash: targetAsset.manifestEntry.fileHash,
            },
          },
          bundleId: targetBundle.id,
        }),
      ],
      [
        `https://storage.example.com/releases${baseAsset.originalPath}`,
        baseAsset.original,
      ],
      [
        `https://storage.example.com/releases${targetAsset.originalPath}`,
        targetAsset.original,
      ],
    ]);
    const get = vi.fn<NonNullable<StorageAdapter["get"]>>(
      async ({ storageUri }) => ({
        response: responses.has(storageUri)
          ? new Response(responses.get(storageUri) as BodyInit)
          : null,
      }),
    );
    const directFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", directFetch);
    const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
      async ({ key }) => ({
        storageUri: `https://storage.example.com/${key}`,
      }),
    );

    try {
      await createBundleDiff(
        { baseBundleId: baseBundle.id, bundleId: targetBundle.id },
        {
          core,
          storageAdapter: createStorageAdapter(upload, {
            get,
            protocol: "https",
          }),
        },
      );

      expect(get).toHaveBeenCalledWith({
        storageUri: baseBundle.manifestStorageUri,
      });
      expect(get).toHaveBeenCalledWith({
        storageUri: targetBundle.manifestStorageUri,
      });
      expect(directFetch).not.toHaveBeenCalled();
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
          byteSize: 4,
          patchFileHash: "hash-primary-patch",
          patchStorageUri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
        },
      ],
    });
    const secondaryAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 4, 3]);
    const core = await createCore([
      primaryBaseBundle,
      secondaryBaseBundle,
      targetBundle,
    ]);
    const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
      async ({ key }) => ({
        storageUri: `s3://test-bucket/${key}`,
      }),
    );

    stubStorageFetch([
      { bundle: secondaryBaseBundle, asset: secondaryAsset },
      { bundle: targetBundle, asset: targetAsset },
    ]);

    try {
      const updatedBundle = await createBundleDiff(
        {
          baseBundleId: secondaryBaseBundle.id,
          bundleId: targetBundle.id,
        },
        {
          core,
          storageAdapter: createStorageAdapter(upload),
        },
        {
          makePrimary: false,
        },
      );

      expect(updatedBundle.patches).toMatchObject([
        {
          baseBundleId: primaryBaseBundle.id,
          baseFileHash: "hash-primary-old",
          patchFileHash: "hash-primary-patch",
          patchStorageUri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
        },
        {
          baseBundleId: secondaryBaseBundle.id,
          baseFileHash: secondaryAsset.manifestEntry.fileHash,
          patchFileHash: expect.any(String),
          patchStorageUri: expect.stringContaining(
            `bundles/${targetBundle.id}/patches/${secondaryBaseBundle.id}`,
          ),
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("rejects a compressed asset that does not match its download hash before decoding it", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001");
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002");
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const core = await createCore([baseBundle, targetBundle]);
    const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
      async ({ key }) => ({ storageUri: `s3://test-bucket/${key}` }),
    );
    // Not a Brotli stream: decoding it would fail with a different error.
    stubStorageFetch([
      { bundle: baseBundle, asset: baseAsset, body: new Uint8Array([0xff]) },
      { bundle: targetBundle, asset: targetAsset },
    ]);

    try {
      await expect(
        createBundleDiff(
          { baseBundleId: baseBundle.id, bundleId: targetBundle.id },
          { core, storageAdapter: createStorageAdapter(upload) },
        ),
      ).rejects.toThrow(
        `Storage object does not match its hash: s3://test-bucket/releases${baseAsset.compressedPath}`,
      );
      expect(upload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a compressed asset that decodes to bytes other than its file hash", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001");
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002");
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const tamperedBase: Asset = {
      ...baseAsset,
      manifestEntry: { ...baseAsset.manifestEntry, fileHash: "c".repeat(64) },
    };
    const core = await createCore([baseBundle, targetBundle]);
    const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
      async ({ key }) => ({ storageUri: `s3://test-bucket/${key}` }),
    );
    stubStorageFetch([
      { bundle: baseBundle, asset: tamperedBase },
      { bundle: targetBundle, asset: targetAsset },
    ]);

    try {
      await expect(
        createBundleDiff(
          { baseBundleId: baseBundle.id, bundleId: targetBundle.id },
          { core, storageAdapter: createStorageAdapter(upload) },
        ),
      ).rejects.toThrow(
        `Storage object does not match its hash: s3://test-bucket/releases${baseAsset.compressedPath}`,
      );
      expect(upload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an uncompressed asset that does not match its file hash", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001", {
      assetBaseStorageUri: "https://storage.example.com/releases/assets",
      manifestStorageUri:
        "https://storage.example.com/releases/base/manifest.json",
    });
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002", {
      assetBaseStorageUri: "https://storage.example.com/releases/assets",
      manifestStorageUri:
        "https://storage.example.com/releases/target/manifest.json",
    });
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const core = await createCore([baseBundle, targetBundle]);
    const responses = new Map<string, string | Uint8Array>([
      [
        baseBundle.manifestStorageUri!,
        JSON.stringify({
          assets: {
            "index.ios.bundle": { fileHash: baseAsset.manifestEntry.fileHash },
          },
          bundleId: baseBundle.id,
        }),
      ],
      [
        targetBundle.manifestStorageUri!,
        JSON.stringify({
          assets: {
            "index.ios.bundle": {
              fileHash: targetAsset.manifestEntry.fileHash,
            },
          },
          bundleId: targetBundle.id,
        }),
      ],
      [
        `https://storage.example.com/releases${baseAsset.originalPath}`,
        new Uint8Array([9, 9, 9]),
      ],
      [
        `https://storage.example.com/releases${targetAsset.originalPath}`,
        targetAsset.original,
      ],
    ]);
    const get = vi.fn<NonNullable<StorageAdapter["get"]>>(
      async ({ storageUri }) => ({
        response: responses.has(storageUri)
          ? new Response(responses.get(storageUri) as BodyInit)
          : null,
      }),
    );
    const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
      async ({ key }) => ({ storageUri: `https://storage.example.com/${key}` }),
    );

    await expect(
      createBundleDiff(
        { baseBundleId: baseBundle.id, bundleId: targetBundle.id },
        {
          core,
          storageAdapter: createStorageAdapter(upload, {
            get,
            protocol: "https",
          }),
        },
      ),
    ).rejects.toThrow(
      `Storage object does not match its hash: https://storage.example.com/releases${baseAsset.originalPath}`,
    );
    expect(upload).not.toHaveBeenCalled();
  });
});
