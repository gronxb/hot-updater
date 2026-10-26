import { createHash, generateKeyPairSync, sign } from "node:crypto";
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

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** The manifest.json deploy uploads for `bundleId`. */
const manifestJson = (bundleId: string, assets: Record<string, unknown>) =>
  JSON.stringify({ assets, bundleId });

/** A bundle whose `manifestFileHash` is the SHA-256 of its manifest with `assets`. */
const createBundle = (
  id: string,
  overrides: Partial<Bundle> = {},
  assets: Record<string, unknown> = {},
): Bundle => ({
  gitCommitHash: null,
  id,
  assetBaseStorageUri: "s3://test-bucket/releases/assets",
  manifestStorageUri: `s3://test-bucket/releases/bundles/${id}/manifest.json`,
  metadata: {},
  platform: "ios",
  manifestFileHash: sha256(manifestJson(id, assets)),
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

/** The manifest assets of a bundle whose only file is `asset`. */
const hermesAssets = (asset: Pick<Asset, "manifestEntry">) => ({
  "index.ios.bundle": asset.manifestEntry,
});

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
          return new Response(manifestJson(bundle.id, hermesAssets(asset)));
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
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const baseBundle = createBundle(
      "00000000-0000-0000-0000-000000000001",
      {},
      hermesAssets(baseAsset),
    );
    const targetBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
      {},
      hermesAssets(targetAsset),
    );
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
    const baseAssets = {
      "index.ios.bundle": { fileHash: "hash-old" },
      "secondary.ios.bundle": { fileHash: "hash-secondary-old" },
    };
    const targetAssets = {
      "index.ios.bundle": { fileHash: "hash-new" },
      "secondary.ios.bundle": { fileHash: "hash-secondary-new" },
    };
    const baseBundle = createBundle(
      "00000000-0000-0000-0000-000000000001",
      {},
      baseAssets,
    );
    const targetBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
      {},
      targetAssets,
    );
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
          return new Response(manifestJson(baseBundle.id, baseAssets));
        }

        if (url.endsWith(`${targetBundle.id}/manifest.json`)) {
          return new Response(manifestJson(targetBundle.id, targetAssets));
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
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const baseBundle = createBundle(
      "00000000-0000-0000-0000-000000000001",
      {
        assetBaseStorageUri: "https://storage.example.com/releases/assets",
        manifestStorageUri:
          "https://storage.example.com/releases/base/manifest.json",
      },
      hermesAssets(baseAsset),
    );
    const targetBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
      {
        assetBaseStorageUri: "https://storage.example.com/releases/assets",
        manifestStorageUri:
          "https://storage.example.com/releases/target/manifest.json",
      },
      hermesAssets(targetAsset),
    );
    const core = await createCore([baseBundle, targetBundle]);
    const responses = new Map<string, string | Uint8Array>([
      [
        baseBundle.manifestStorageUri!,
        manifestJson(baseBundle.id, hermesAssets(baseAsset)),
      ],
      [
        targetBundle.manifestStorageUri!,
        manifestJson(targetBundle.id, hermesAssets(targetAsset)),
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
    const secondaryAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 4, 3]);
    const secondaryBaseBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
      {},
      hermesAssets(secondaryAsset),
    );
    const targetBundle = createBundle(
      "00000000-0000-0000-0000-000000000003",
      {
        patches: [
          {
            baseBundleId: primaryBaseBundle.id,
            baseFileHash: "hash-primary-old",
            byteSize: 4,
            patchFileHash: "hash-primary-patch",
            patchStorageUri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
          },
        ],
      },
      hermesAssets(targetAsset),
    );
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
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const baseBundle = createBundle(
      "00000000-0000-0000-0000-000000000001",
      {},
      hermesAssets(baseAsset),
    );
    const targetBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
      {},
      hermesAssets(targetAsset),
    );
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
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const tamperedBase: Asset = {
      ...baseAsset,
      manifestEntry: { ...baseAsset.manifestEntry, fileHash: "c".repeat(64) },
    };
    const baseBundle = createBundle(
      "00000000-0000-0000-0000-000000000001",
      {},
      hermesAssets(tamperedBase),
    );
    const targetBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
      {},
      hermesAssets(targetAsset),
    );
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
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const baseBundle = createBundle(
      "00000000-0000-0000-0000-000000000001",
      {
        assetBaseStorageUri: "https://storage.example.com/releases/assets",
        manifestStorageUri:
          "https://storage.example.com/releases/base/manifest.json",
      },
      hermesAssets(baseAsset),
    );
    const targetBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
      {
        assetBaseStorageUri: "https://storage.example.com/releases/assets",
        manifestStorageUri:
          "https://storage.example.com/releases/target/manifest.json",
      },
      hermesAssets(targetAsset),
    );
    const core = await createCore([baseBundle, targetBundle]);
    const responses = new Map<string, string | Uint8Array>([
      [
        baseBundle.manifestStorageUri!,
        manifestJson(baseBundle.id, hermesAssets(baseAsset)),
      ],
      [
        targetBundle.manifestStorageUri!,
        manifestJson(targetBundle.id, hermesAssets(targetAsset)),
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
  it("rejects a Hermes bundle without a download hash before downloading it", async () => {
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    const { downloadFileHash: _, ...entryWithoutDownloadHash } =
      baseAsset.manifestEntry;
    const baseBundle = createBundle(
      "00000000-0000-0000-0000-000000000001",
      {},
      { "index.ios.bundle": entryWithoutDownloadHash },
    );
    const targetBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
      {},
      hermesAssets(targetAsset),
    );
    const core = await createCore([baseBundle, targetBundle]);
    const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
      async ({ key }) => ({ storageUri: `s3://test-bucket/${key}` }),
    );
    stubStorageFetch([
      {
        bundle: baseBundle,
        asset: {
          ...baseAsset,
          manifestEntry: entryWithoutDownloadHash as Asset["manifestEntry"],
        },
      },
      { bundle: targetBundle, asset: targetAsset },
    ]);

    try {
      await expect(
        createBundleDiff(
          { baseBundleId: baseBundle.id, bundleId: targetBundle.id },
          { core, storageAdapter: createStorageAdapter(upload) },
        ),
      ).rejects.toThrow(
        "Asset index.ios.bundle has no download hash for its compressed object",
      );
      const requested = vi
        .mocked(fetch)
        .mock.calls.map(([input]) => String(input));
      expect(
        requested.some((url) => url.endsWith(baseAsset.compressedPath)),
      ).toBe(false);
      expect(upload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("rejects a manifest that does not match the bundle's manifest hash before reading its assets", async () => {
    const baseAsset = createAsset([1, 2, 3]);
    const targetAsset = createAsset([1, 9, 3]);
    // The database records the manifest deploy uploaded; storage serves another.
    const baseBundle = createBundle(
      "00000000-0000-0000-0000-000000000001",
      {},
      hermesAssets(createAsset([7, 7, 7])),
    );
    const targetBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
      {},
      hermesAssets(targetAsset),
    );
    const core = await createCore([baseBundle, targetBundle]);
    const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
      async ({ key }) => ({ storageUri: `s3://test-bucket/${key}` }),
    );
    stubStorageFetch([
      { bundle: baseBundle, asset: baseAsset },
      { bundle: targetBundle, asset: targetAsset },
    ]);

    try {
      await expect(
        createBundleDiff(
          { baseBundleId: baseBundle.id, bundleId: targetBundle.id },
          { core, storageAdapter: createStorageAdapter(upload) },
        ),
      ).rejects.toThrow(
        `Manifest of bundle ${baseBundle.id} does not match its hash`,
      );
      const requested = vi
        .mocked(fetch)
        .mock.calls.map(([input]) => String(input));
      expect(
        requested.some((url) => url.endsWith(baseAsset.compressedPath)),
      ).toBe(false);
      expect(upload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("signed manifests", () => {
    const keyPair = () =>
      generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
    const { privateKey, publicKey } = keyPair();

    /** The `sig:` manifest hash deploy records when it signs `manifest`. */
    const signedManifestHash = (manifest: string, key = privateKey) =>
      `sig:${sign(
        "RSA-SHA256",
        createHash("sha256").update(manifest).digest(),
        key,
      ).toString("base64")}`;

    const setup = async (signingKey = privateKey) => {
      const baseAsset = createAsset([1, 2, 3]);
      const targetAsset = createAsset([1, 9, 3]);
      const signed = (id: string, asset: Asset) =>
        createBundle(id, {
          manifestFileHash: signedManifestHash(
            manifestJson(id, hermesAssets(asset)),
            signingKey,
          ),
        });
      const baseBundle = signed(
        "00000000-0000-0000-0000-000000000001",
        baseAsset,
      );
      const targetBundle = signed(
        "00000000-0000-0000-0000-000000000002",
        targetAsset,
      );
      const core = await createCore([baseBundle, targetBundle]);
      const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
        async ({ key }) => ({ storageUri: `s3://test-bucket/${key}` }),
      );
      stubStorageFetch([
        { bundle: baseBundle, asset: baseAsset },
        { bundle: targetBundle, asset: targetAsset },
      ]);
      return { baseBundle, core, targetBundle, upload };
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("verifies signed manifests with the configured public key", async () => {
      const { baseBundle, core, targetBundle, upload } = await setup();

      await createBundleDiff(
        { baseBundleId: baseBundle.id, bundleId: targetBundle.id },
        {
          core,
          signingPublicKey: publicKey,
          storageAdapter: createStorageAdapter(upload),
        },
      );

      expect(upload).toHaveBeenCalledOnce();
    });

    it("rejects a signed manifest without a public key to verify it", async () => {
      const { baseBundle, core, targetBundle, upload } = await setup();

      await expect(
        createBundleDiff(
          { baseBundleId: baseBundle.id, bundleId: targetBundle.id },
          { core, storageAdapter: createStorageAdapter(upload) },
        ),
      ).rejects.toThrow(
        `Manifest of bundle ${baseBundle.id} is signed; configure signing to verify it`,
      );
      expect(upload).not.toHaveBeenCalled();
    });

    it("rejects a manifest signed by another key", async () => {
      const { baseBundle, core, targetBundle, upload } = await setup(
        keyPair().privateKey,
      );

      await expect(
        createBundleDiff(
          { baseBundleId: baseBundle.id, bundleId: targetBundle.id },
          {
            core,
            signingPublicKey: publicKey,
            storageAdapter: createStorageAdapter(upload),
          },
        ),
      ).rejects.toThrow(
        `Manifest of bundle ${baseBundle.id} does not match its signature`,
      );
      expect(upload).not.toHaveBeenCalled();
    });

    describe("a native build's built-in bundle as the base", () => {
      const minBundleId = "01900000-0000-7000-8000-000000000000";
      const targetBundleId = "01900000-0000-7000-8000-000000000001";

      /**
       * A signed target, and the built-in bundle of a registered native
       * build: registration records its manifest's SHA-256, never a
       * signature, as `native-build ios|android` does.
       */
      const setupBuiltIn = async (builtInManifest?: string) => {
        const baseAsset = createAsset([1, 2, 3]);
        const targetAsset = createAsset([1, 9, 3]);
        const targetBundle = createBundle(targetBundleId, {
          manifestFileHash: signedManifestHash(
            manifestJson(targetBundleId, hermesAssets(targetAsset)),
          ),
        });
        const core = await createCore([targetBundle]);
        await core.registerNativeBuild({
          id: "01900000-0000-7000-8000-00000000b001",
          platform: "ios",
          channel: "production",
          fingerprintHash: "fingerprint-hash",
          appVersion: null,
          minBundleId,
          gitCommitHash: null,
          buildKey: null,
          artifact: {
            kind: "ipa",
            storageUri: "s3://test-bucket/native-builds/ios/b001",
            byteSize: 1_024,
          },
          embeddedBundle: {
            manifestStorageUri: `s3://test-bucket/releases/bundles/${minBundleId}/manifest.json`,
            manifestFileHash: sha256(
              manifestJson(minBundleId, hermesAssets(baseAsset)),
            ),
            assetBaseStorageUri: "s3://test-bucket/releases/assets",
          },
        });
        const fetchMock = vi.fn(async (input: Request | URL | string) => {
          const url = String(input);
          if (url.endsWith(`${minBundleId}/manifest.json`)) {
            return new Response(
              builtInManifest ??
                manifestJson(minBundleId, hermesAssets(baseAsset)),
            );
          }
          if (url.endsWith(`${targetBundleId}/manifest.json`)) {
            return new Response(
              manifestJson(targetBundleId, hermesAssets(targetAsset)),
            );
          }
          for (const asset of [baseAsset, targetAsset]) {
            if (url.endsWith(asset.compressedPath)) {
              return new Response(asset.compressed as BodyInit);
            }
          }
          return new Response("not found", { status: 404 });
        });
        vi.stubGlobal("fetch", fetchMock);
        const upload = vi.fn<NonNullable<StorageAdapter["put"]>>(
          async ({ key }) => ({ storageUri: `s3://test-bucket/${key}` }),
        );
        return { baseAsset, core, fetchMock, upload };
      };

      it("patches a signed bundle from it with the configured public key", async () => {
        const { core, upload } = await setupBuiltIn();

        await createBundleDiff(
          { baseBundleId: minBundleId, bundleId: targetBundleId },
          {
            core,
            signingPublicKey: publicKey,
            storageAdapter: createStorageAdapter(upload),
          },
        );

        expect(upload).toHaveBeenCalledOnce();
        expect(
          (await storedBundle(core, targetBundleId))?.patches?.map(
            (patch) => patch.baseBundleId,
          ),
        ).toEqual([minBundleId]);
      });

      it("rejects its manifest when it does not match the registered hash, before reading its assets", async () => {
        const { baseAsset, core, fetchMock, upload } = await setupBuiltIn(
          manifestJson(minBundleId, hermesAssets(createAsset([7, 7, 7]))),
        );

        await expect(
          createBundleDiff(
            { baseBundleId: minBundleId, bundleId: targetBundleId },
            {
              core,
              signingPublicKey: publicKey,
              storageAdapter: createStorageAdapter(upload),
            },
          ),
        ).rejects.toThrow(
          `Manifest of bundle ${minBundleId} does not match its hash`,
        );
        expect(
          fetchMock.mock.calls.some(([input]) =>
            String(input).endsWith(baseAsset.compressedPath),
          ),
        ).toBe(false);
        expect(upload).not.toHaveBeenCalled();
      });
    });
  });
});
