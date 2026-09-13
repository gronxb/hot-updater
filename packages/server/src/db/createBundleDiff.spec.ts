import { brotliCompressSync } from "node:zlib";

import { hdiff } from "@hot-updater/bsdiff";
import type { Bundle, BundleManifest } from "@hot-updater/core";
import type {
  DatabasePlugin,
  StoragePlugin,
  StoragePluginWith,
} from "@hot-updater/plugin-core";
import {
  createDatabaseClient,
  createStoragePlugin as createCoreStoragePlugin,
  getManifestAssetDownloadPath,
  MAX_BUNDLE_ARTIFACT_BYTES,
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_PATCHES,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInMemoryDatabaseHarness,
  createInMemoryDatabasePlugin,
} from "../../../test-utils/test/inMemoryDatabasePlugin";
import { getSha256 } from "./bundleManifestValidation";
import { createBundleDiff, decompressBrotliBytes } from "./createBundleDiff";
import { hasCanonicalManifestAssetPaths } from "./manifestAssetPath";

vi.mock("@hot-updater/bsdiff", () => ({
  hdiff: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
}));

const BASE_ID = "00000000-0000-0000-0000-000000000001";
const SECOND_BASE_ID = "00000000-0000-0000-0000-000000000002";
const TARGET_ID = "00000000-0000-0000-0000-000000000003";
const ASSET_BASE_URI = "s3://test-bucket/releases/assets";

type StoredManifest = {
  bundle: Bundle;
  manifest: BundleManifest;
  manifestBytes: Uint8Array;
  objects: Map<string, Uint8Array>;
};

const encode = (value: string) => new TextEncoder().encode(value);

const createBundle = (
  id: string,
  manifestBytes: Uint8Array,
  overrides: Partial<Bundle> = {},
): Bundle => ({
  archiveByteSize: 1_024,
  assetBaseStorageUri: ASSET_BASE_URI,
  fileHash: getSha256(encode(`${id}-archive`)),
  gitCommitHash: null,
  id,
  manifestFileHash: getSha256(manifestBytes),
  manifestStorageUri: `s3://test-bucket/releases/bundles/${id}/manifest.json`,
  metadata: {},
  platform: "ios",
  storageUri: `s3://test-bucket/releases/bundles/${id}/bundle.zip`,
  ...overrides,
});

const createStoredManifest = ({
  assetPath = "runtime/entry.lynxbc",
  bundleId,
  compression = "br",
  logicalBytes,
  patchAssetPath = assetPath,
}: {
  assetPath?: string;
  bundleId: string;
  compression?: "br" | null;
  logicalBytes: Uint8Array;
  patchAssetPath?: string;
}): StoredManifest => {
  const downloadBytes =
    compression === "br"
      ? new Uint8Array(brotliCompressSync(logicalBytes))
      : logicalBytes;
  const asset = {
    downloadByteSize: downloadBytes.byteLength,
    downloadCompression: compression,
    downloadFileHash: getSha256(downloadBytes),
    fileHash: getSha256(logicalBytes),
  };
  const manifest: BundleManifest = {
    assets: { [assetPath]: asset },
    bundleId,
    patchAssetPath,
  };
  const manifestBytes = encode(JSON.stringify(manifest));
  const bundle = createBundle(bundleId, manifestBytes);
  const downloadPath = getManifestAssetDownloadPath(assetPath, compression);
  const storageUri = resolveManifestAssetStorageUri({
    assetBaseStorageUri: ASSET_BASE_URI,
    assetPath: downloadPath,
    downloadFileHash: asset.downloadFileHash,
    fileHash: asset.fileHash,
  });
  return {
    bundle,
    manifest,
    manifestBytes,
    objects: new Map([
      [bundle.manifestStorageUri!, manifestBytes],
      [storageUri, downloadBytes],
    ]),
  };
};

const createDatabasePlugin = async (
  bundles: readonly Bundle[],
): Promise<DatabasePlugin> => {
  const plugin = createInMemoryDatabasePlugin();
  const client = createDatabaseClient(plugin);
  for (const bundle of bundles) await client.insertBundle(bundle);
  return plugin;
};

const createStorage = (
  objects: ReadonlyMap<string, Uint8Array>,
  overrides: {
    delete?: NonNullable<StoragePlugin["delete"]>;
    get?: NonNullable<StoragePlugin["get"]>;
    put?: NonNullable<StoragePlugin["put"]>;
  } = {},
) => {
  const get = vi.fn<NonNullable<StoragePlugin["get"]>>(
    overrides.get ??
      (async ({ storageUri }) => ({
        response: objects.has(storageUri)
          ? new Response(objects.get(storageUri))
          : null,
      })),
  );
  const put =
    overrides.put ??
    vi.fn<NonNullable<StoragePlugin["put"]>>(async ({ key }) => ({
      storageUri: `s3://test-bucket/${key}`,
    }));
  const remove =
    overrides.delete ??
    vi.fn<NonNullable<StoragePlugin["delete"]>>(async () => ({
      deleted: true,
    }));
  const plugin: StoragePluginWith<"get" | "put" | "delete"> =
    createCoreStoragePlugin({
      delete: remove,
      get,
      name: "test-storage",
      protocol: "s3",
      put,
    });
  return { get, plugin, put, remove };
};

const mergeObjects = (...stored: readonly StoredManifest[]) =>
  new Map(stored.flatMap(({ objects }) => [...objects]));

const useSignedManifestToken = (stored: StoredManifest) => {
  stored.bundle.manifestFileHash = "sig:dGVzdC1zaWduYXR1cmU=";
  stored.bundle.metadata = {
    ...stored.bundle.metadata,
    manifest_content_hash: getSha256(stored.manifestBytes),
  };
};

describe("createBundleDiff", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("patches an explicitly selected opaque Brotli asset", async () => {
    const base = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1, 2, 3]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([1, 9, 3]),
    });
    useSignedManifestToken(base);
    useSignedManifestToken(target);
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    const publish = vi.spyOn(databasePlugin.models.bundlePatches, "publish");
    const storage = createStorage(mergeObjects(base, target));

    const result = await createBundleDiff(
      { baseBundleId: BASE_ID, bundleId: TARGET_ID },
      { databasePlugin, storagePlugin: storage.plugin },
    );

    expect(hdiff).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([1, 9, 3]),
    );
    expect(storage.put).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(result.patches).toEqual([
      expect.objectContaining({
        baseBundleId: BASE_ID,
        baseFileHash: base.manifest.assets["runtime/entry.lynxbc"]!.fileHash,
        patchFileHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("publishes reverse patches for consecutive rollback targets", async () => {
    const first = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const second = createStoredManifest({
      bundleId: SECOND_BASE_ID,
      logicalBytes: new Uint8Array([2]),
    });
    const third = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([3]),
    });
    const databasePlugin = await createDatabasePlugin([
      first.bundle,
      second.bundle,
      third.bundle,
    ]);
    const storage = createStorage(mergeObjects(first, second, third));

    await createBundleDiff(
      { baseBundleId: third.bundle.id, bundleId: second.bundle.id },
      { databasePlugin, storagePlugin: storage.plugin },
    );
    await createBundleDiff(
      { baseBundleId: second.bundle.id, bundleId: first.bundle.id },
      { databasePlugin, storagePlugin: storage.plugin },
    );

    const database = createDatabaseClient(databasePlugin);
    await expect(
      database.getBundleById(second.bundle.id),
    ).resolves.toMatchObject({
      patches: [expect.objectContaining({ baseBundleId: third.bundle.id })],
    });
    await expect(
      database.getBundleById(first.bundle.id),
    ).resolves.toMatchObject({
      patches: [expect.objectContaining({ baseBundleId: second.bundle.id })],
    });
    expect(storage.put).toHaveBeenCalledTimes(2);
  });

  it("reads an explicitly raw patch asset without Brotli decoding", async () => {
    const base = createStoredManifest({
      assetPath: "runtime/startup.dat",
      bundleId: BASE_ID,
      compression: null,
      logicalBytes: new Uint8Array([4, 5, 6]),
    });
    const target = createStoredManifest({
      assetPath: "runtime/startup.dat",
      bundleId: TARGET_ID,
      compression: null,
      logicalBytes: new Uint8Array([4, 8, 6]),
    });
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    const storage = createStorage(mergeObjects(base, target));

    await createBundleDiff(
      { baseBundleId: BASE_ID, bundleId: TARGET_ID },
      { databasePlugin, storagePlugin: storage.plugin },
    );

    expect(hdiff).toHaveBeenCalledWith(
      new Uint8Array([4, 5, 6]),
      new Uint8Array([4, 8, 6]),
    );
    expect(
      storage.get.mock.calls.map(([{ storageUri }]) => storageUri),
    ).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.br$/)]));
  });

  it("does not infer a patch entry from misleading .bundle names", async () => {
    const base = createStoredManifest({
      assetPath: "index.ios.bundle",
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
      patchAssetPath: undefined,
    });
    const target = createStoredManifest({
      assetPath: "index.ios.bundle",
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
      patchAssetPath: undefined,
    });
    delete base.manifest.patchAssetPath;
    delete target.manifest.patchAssetPath;
    for (const stored of [base, target]) {
      stored.manifestBytes = encode(JSON.stringify(stored.manifest));
      stored.bundle.manifestFileHash = getSha256(stored.manifestBytes);
      stored.objects.set(
        stored.bundle.manifestStorageUri!,
        stored.manifestBytes,
      );
    }
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    const storage = createStorage(mergeObjects(base, target));

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).rejects.toThrow("Manifest must name an existing patchAssetPath");
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("rejects patch entry disagreement and legacy compression before asset reads", async () => {
    const base = createStoredManifest({
      assetPath: "runtime/base.bin",
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const target = createStoredManifest({
      assetPath: "runtime/target.bin",
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
    });
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    const storage = createStorage(mergeObjects(base, target));

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).rejects.toThrow("patchAssetPath values do not match");
    expect(storage.get).toHaveBeenCalledTimes(2);

    const legacyManifest = {
      ...target.manifest,
      assets: {
        "runtime/base.bin": {
          fileHash: "a".repeat(64),
        },
      },
      patchAssetPath: "runtime/base.bin",
    } satisfies BundleManifest;
    const legacyBytes = encode(JSON.stringify(legacyManifest));
    const legacyBundle = createBundle(TARGET_ID, legacyBytes);
    const legacyDatabase = await createDatabasePlugin([
      base.bundle,
      legacyBundle,
    ]);
    const legacyStorage = createStorage(
      new Map([
        ...base.objects,
        [legacyBundle.manifestStorageUri!, legacyBytes],
      ]),
    );

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin: legacyDatabase, storagePlugin: legacyStorage.plugin },
      ),
    ).rejects.toThrow("does not declare a verifiable download representation");
    expect(legacyStorage.get).toHaveBeenCalledTimes(2);
    expect(legacyStorage.put).not.toHaveBeenCalled();
  });

  it.each([
    ["parent segment", ["runtime/../entry.bin"]],
    ["backslash", ["runtime\\entry.bin"]],
    ["reserved manifest descendant", ["MANIFEST.JSON/data"]],
    ["case alias", ["Runtime/Entry.bin", "runtime/entry.bin"]],
    ["NFC alias", ["assets/Caf\u00e9.bin", "assets/Cafe\u0301.bin"]],
    ["Greek final sigma alias", ["runtime/\u03a3.bin", "runtime/\u03c2.bin"]],
    ["sharp-S alias", ["runtime/stra\u00dfe.bin", "runtime/STRASSE.bin"]],
    ["case-folded directory alias", ["A/x.bin", "a/y.bin"]],
    ["NFC directory alias", ["caf\u00e9/x.bin", "cafe\u0301/y.bin"]],
    ["full-fold directory alias", ["Stra\u00dfe/x.bin", "STRASSE/y.bin"]],
    ["ancestor first", ["runtime", "runtime/entry.lynxbc"]],
    ["descendant first", ["runtime/entry.lynxbc", "RUNTIME"]],
  ])(
    "rejects a %s manifest conflict before asset or mutation side effects",
    async (_label, assetPaths) => {
      const base = createStoredManifest({
        bundleId: BASE_ID,
        logicalBytes: new Uint8Array([1]),
      });
      const assets = Object.fromEntries(
        assetPaths.map((assetPath, index) => [
          assetPath,
          {
            downloadByteSize: 1,
            downloadCompression: null,
            downloadFileHash: String(index + 1).repeat(64),
            fileHash: String(index + 1).repeat(64),
          },
        ]),
      );
      const manifest: BundleManifest = {
        assets,
        bundleId: TARGET_ID,
        patchAssetPath: assetPaths[0],
      };
      const bytes = encode(JSON.stringify(manifest));
      const targetBundle = createBundle(TARGET_ID, bytes);
      const databasePlugin = await createDatabasePlugin([
        base.bundle,
        targetBundle,
      ]);
      const publish = vi.spyOn(databasePlugin.models.bundlePatches, "publish");
      const storage = createStorage(
        new Map([...base.objects, [targetBundle.manifestStorageUri!, bytes]]),
      );

      await expect(
        createBundleDiff(
          { baseBundleId: BASE_ID, bundleId: TARGET_ID },
          { databasePlugin, storagePlugin: storage.plugin },
        ),
      ).rejects.toThrow(`Invalid manifest payload for bundle ${TARGET_ID}`);
      expect(storage.get).toHaveBeenCalledTimes(2);
      expect(hdiff).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("rejects a manifest whose files and parent directories exceed the archive-entry limit", () => {
    const assetPaths = Array.from(
      { length: 5_000 },
      (_, index) => `dir-${index}/entry`,
    );

    expect(
      hasCanonicalManifestAssetPaths({
        assetPaths,
        patchAssetPath: assetPaths[0],
      }),
    ).toBe(false);
  });

  it("rejects a stored manifest that does not match its database hash", async () => {
    const base = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
    });
    target.bundle.manifestFileHash = "0".repeat(64);
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    const publish = vi.spyOn(databasePlugin.models.bundlePatches, "publish");
    const storage = createStorage(mergeObjects(base, target));

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).rejects.toThrow(`Invalid manifest payload for bundle ${TARGET_ID}`);
    expect(storage.get).toHaveBeenCalledTimes(2);
    expect(storage.put).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ["raw", null],
    ["Brotli", "br"],
  ] as const)(
    "rejects a corrupt %s representation without publishing a patch",
    async (_label, compression) => {
      const base = createStoredManifest({
        bundleId: BASE_ID,
        compression,
        logicalBytes: new Uint8Array([1, 2, 3]),
      });
      const target = createStoredManifest({
        bundleId: TARGET_ID,
        compression,
        logicalBytes: new Uint8Array([1, 9, 3]),
      });
      const targetAsset = target.manifest.assets["runtime/entry.lynxbc"]!;
      const targetUri = resolveManifestAssetStorageUri({
        assetBaseStorageUri: ASSET_BASE_URI,
        assetPath: getManifestAssetDownloadPath(
          "runtime/entry.lynxbc",
          compression,
        ),
        downloadFileHash: targetAsset.downloadFileHash,
        fileHash: targetAsset.fileHash,
      });
      const original = target.objects.get(targetUri)!;
      const corrupt = original.slice();
      corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
      target.objects.set(targetUri, corrupt);
      const databasePlugin = await createDatabasePlugin([
        base.bundle,
        target.bundle,
      ]);
      const publish = vi.spyOn(databasePlugin.models.bundlePatches, "publish");
      const storage = createStorage(mergeObjects(base, target));

      await expect(
        createBundleDiff(
          { baseBundleId: BASE_ID, bundleId: TARGET_ID },
          { databasePlugin, storagePlugin: storage.plugin },
        ),
      ).rejects.toThrow("Invalid download representation");
      expect(hdiff).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("preserves two bases published concurrently through independent repositories", async () => {
    const firstBase = createStoredManifest({
      bundleId: BASE_ID,
      compression: null,
      logicalBytes: new Uint8Array([1]),
    });
    const secondBase = createStoredManifest({
      bundleId: SECOND_BASE_ID,
      compression: null,
      logicalBytes: new Uint8Array([2]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      compression: null,
      logicalBytes: new Uint8Array([3]),
    });
    const harness = createInMemoryDatabaseHarness();
    const firstRepository = harness.plugin;
    const secondRepository = harness.createPlugin();
    const database = createDatabaseClient(firstRepository);
    for (const stored of [firstBase, secondBase, target]) {
      await database.insertBundle(stored.bundle);
    }
    let releaseUploads = () => {};
    const bothUploadsStarted = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    let uploadCount = 0;
    const uploaded = new Set<string>();
    const put = vi.fn<NonNullable<StoragePlugin["put"]>>(async ({ key }) => {
      uploadCount += 1;
      if (uploadCount === 2) releaseUploads();
      await bothUploadsStarted;
      const storageUri = `s3://test-bucket/${key}`;
      uploaded.add(storageUri);
      return { storageUri };
    });
    const remove = vi.fn<NonNullable<StoragePlugin["delete"]>>(
      async ({ storageUri }) => {
        uploaded.delete(storageUri);
        return { deleted: true };
      },
    );
    const storage = createStorage(mergeObjects(firstBase, secondBase, target), {
      delete: remove,
      put,
    });

    await Promise.all([
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin: firstRepository, storagePlugin: storage.plugin },
      ),
      createBundleDiff(
        { baseBundleId: SECOND_BASE_ID, bundleId: TARGET_ID },
        { databasePlugin: secondRepository, storagePlugin: storage.plugin },
      ),
    ]);

    const persisted = await database.getBundleById(TARGET_ID);
    expect(
      persisted?.patches?.map(({ baseBundleId }) => baseBundleId).sort(),
    ).toEqual([BASE_ID, SECOND_BASE_ID]);
    expect(uploaded.size).toBe(2);
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects a new base at the shared patch limit before storage access", async () => {
    const placeholderManifest = encode("{}");
    const baseBundle = createBundle(BASE_ID, placeholderManifest);
    const patchBaseBundles = Array.from(
      { length: MAX_BUNDLE_PATCHES },
      (_, index) =>
        createBundle(
          `00000000-0000-0000-0000-${String(index + 100).padStart(12, "0")}`,
          placeholderManifest,
        ),
    );
    const targetBundle = createBundle(TARGET_ID, placeholderManifest, {
      patches: patchBaseBundles.map(({ id: baseBundleId }, index) => ({
        baseBundleId,
        baseFileHash: "a".repeat(64),
        byteSize: 4,
        patchFileHash: "b".repeat(64),
        patchStorageUri: `s3://test-bucket/patch-${index}`,
      })),
    });
    const databasePlugin = await createDatabasePlugin([
      baseBundle,
      ...patchBaseBundles,
      targetBundle,
    ]);
    const publish = vi.spyOn(databasePlugin.models.bundlePatches, "publish");
    const storage = createStorage(new Map());

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).rejects.toThrow(
      `Target bundle cannot contain more than ${MAX_BUNDLE_PATCHES} patches`,
    );
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("removes the upload when atomic publication is unsupported", async () => {
    const base = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
    });
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    delete databasePlugin.models.bundlePatches.publish;
    const remove = vi.fn<NonNullable<StoragePlugin["delete"]>>(async () => ({
      deleted: true,
    }));
    const storage = createStorage(mergeObjects(base, target), {
      delete: remove,
    });

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).rejects.toThrow("cannot atomically publish bundle patches");
    expect(storage.put).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("retains the upload when database publication has an ambiguous failure", async () => {
    const base = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
    });
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    vi.spyOn(databasePlugin.models.bundlePatches, "publish").mockRejectedValue(
      new Error("database unavailable"),
    );
    const remove = vi.fn<NonNullable<StoragePlugin["delete"]>>(async () => ({
      deleted: true,
    }));
    const storage = createStorage(mergeObjects(base, target), {
      delete: remove,
    });

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).rejects.toThrow("database unavailable");
    expect(storage.put).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it("retains a committed upload when publication response and recovery read are lost", async () => {
    const base = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
    });
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    const publish = databasePlugin.models.bundlePatches.publish;
    if (!publish) throw new Error("Missing atomic patch publication");
    let publicationCommitted = false;
    vi.spyOn(databasePlugin.models.bundlePatches, "publish").mockImplementation(
      async (input) => {
        await publish(input);
        publicationCommitted = true;
        throw new Error("publication response lost");
      },
    );
    const findPatches = databasePlugin.models.bundlePatches.findByBundleIds;
    vi.spyOn(
      databasePlugin.models.bundlePatches,
      "findByBundleIds",
    ).mockImplementation(async (bundleIds) =>
      publicationCommitted && bundleIds.includes(TARGET_ID)
        ? []
        : findPatches(bundleIds),
    );
    const remove = vi.fn<NonNullable<StoragePlugin["delete"]>>(async () => ({
      deleted: true,
    }));
    const storage = createStorage(mergeObjects(base, target), {
      delete: remove,
    });

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).rejects.toThrow("publication response lost");
    expect(storage.put).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it("retains the superseded patch after a successful replacement", async () => {
    const base = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
    });
    const previousPatchStorageUri = "s3://test-bucket/previous.patch";
    target.bundle.patches = [
      {
        baseBundleId: BASE_ID,
        baseFileHash: base.manifest.assets["runtime/entry.lynxbc"]!.fileHash,
        byteSize: 3,
        patchFileHash: "a".repeat(64),
        patchStorageUri: previousPatchStorageUri,
      },
    ];
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    const remove = vi.fn<NonNullable<StoragePlugin["delete"]>>(async () => ({
      deleted: true,
    }));
    const storage = createStorage(mergeObjects(base, target), {
      delete: remove,
    });

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).resolves.toMatchObject({
      patches: [
        expect.objectContaining({
          baseBundleId: BASE_ID,
          patchStorageUri: expect.not.stringContaining("previous.patch"),
        }),
      ],
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("retains the superseded patch after recovering a committed replacement", async () => {
    const base = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
    });
    const previousPatchStorageUri = "s3://test-bucket/previous.patch";
    target.bundle.patches = [
      {
        baseBundleId: BASE_ID,
        baseFileHash: base.manifest.assets["runtime/entry.lynxbc"]!.fileHash,
        byteSize: 3,
        patchFileHash: "a".repeat(64),
        patchStorageUri: previousPatchStorageUri,
      },
    ];
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    const publish = databasePlugin.models.bundlePatches.publish;
    if (!publish) throw new Error("Missing atomic patch publication");
    vi.spyOn(databasePlugin.models.bundlePatches, "publish").mockImplementation(
      async (input) => {
        await publish(input);
        throw new Error("publication response lost");
      },
    );
    const remove = vi.fn<NonNullable<StoragePlugin["delete"]>>(async () => ({
      deleted: true,
    }));
    const storage = createStorage(mergeObjects(base, target), {
      delete: remove,
    });

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).resolves.toMatchObject({
      patches: [
        expect.objectContaining({
          baseBundleId: BASE_ID,
          patchStorageUri: expect.not.stringContaining("previous.patch"),
        }),
      ],
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("retains a superseded object when another repository republishes it", async () => {
    const base = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
    });
    const previousPatchStorageUri = "s3://test-bucket/shared.patch";
    const previousPatch = {
      baseBundleId: BASE_ID,
      baseFileHash: base.manifest.assets["runtime/entry.lynxbc"]!.fileHash,
      byteSize: 3,
      patchFileHash: "a".repeat(64),
      patchStorageUri: previousPatchStorageUri,
    };
    target.bundle.patches = [previousPatch];
    const harness = createInMemoryDatabaseHarness();
    const publishingRepository = harness.plugin;
    const republishingRepository = harness.createPlugin();
    const database = createDatabaseClient(publishingRepository);
    for (const stored of [base, target]) {
      await database.insertBundle(stored.bundle);
    }
    const publish = publishingRepository.models.bundlePatches.publish;
    const republish = republishingRepository.models.bundlePatches.publish;
    if (!publish || !republish) {
      throw new Error("Missing atomic patch publication");
    }
    vi.spyOn(
      publishingRepository.models.bundlePatches,
      "publish",
    ).mockImplementation(async (input) => {
      const result = await publish(input);
      await republish({
        position: "primary",
        row: {
          base_bundle_id: BASE_ID,
          base_file_hash: previousPatch.baseFileHash,
          bundle_id: TARGET_ID,
          byte_size: previousPatch.byteSize,
          id: `${TARGET_ID}:${BASE_ID}`,
          patch_file_hash: previousPatch.patchFileHash,
          patch_storage_uri: previousPatch.patchStorageUri,
        },
      });
      return result;
    });
    const retainedObjects = new Set([previousPatchStorageUri]);
    const remove = vi.fn<NonNullable<StoragePlugin["delete"]>>(
      async ({ storageUri }) => {
        retainedObjects.delete(storageUri);
        return { deleted: true };
      },
    );
    const storage = createStorage(mergeObjects(base, target), {
      delete: remove,
    });

    await createBundleDiff(
      { baseBundleId: BASE_ID, bundleId: TARGET_ID },
      { databasePlugin: publishingRepository, storagePlugin: storage.plugin },
    );

    const persisted = await database.getBundleById(TARGET_ID);
    expect(
      persisted?.patches?.find(({ baseBundleId }) => baseBundleId === BASE_ID)
        ?.patchStorageUri,
    ).toBe(previousPatchStorageUri);
    expect(retainedObjects).toContain(previousPatchStorageUri);
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not accept ambiguous recovery at the opposite requested position", async () => {
    const base = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const secondBase = createStoredManifest({
      bundleId: SECOND_BASE_ID,
      logicalBytes: new Uint8Array([3]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
    });
    target.bundle.patches = [
      {
        baseBundleId: SECOND_BASE_ID,
        baseFileHash:
          secondBase.manifest.assets["runtime/entry.lynxbc"]!.fileHash,
        byteSize: 1,
        patchFileHash: "a".repeat(64),
        patchStorageUri: "s3://test-bucket/existing.patch",
      },
    ];
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      secondBase.bundle,
      target.bundle,
    ]);
    const publish = databasePlugin.models.bundlePatches.publish;
    if (!publish) throw new Error("Missing atomic patch publication");
    vi.spyOn(databasePlugin.models.bundlePatches, "publish").mockImplementation(
      async (input) => {
        await publish({ ...input, position: "last" });
        throw new Error("publication response lost");
      },
    );
    const remove = vi.fn<NonNullable<StoragePlugin["delete"]>>(async () => ({
      deleted: true,
    }));
    const storage = createStorage(mergeObjects(base, secondBase, target), {
      delete: remove,
    });

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).rejects.toThrow("publication response lost");
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    ["manifest", MAX_BUNDLE_MANIFEST_BYTES],
    ["asset", MAX_BUNDLE_ARTIFACT_BYTES],
  ] as const)(
    "rejects an oversized %s response from Content-Length before patching",
    async (kind, limit) => {
      const base = createStoredManifest({
        bundleId: BASE_ID,
        logicalBytes: new Uint8Array([1]),
      });
      const target = createStoredManifest({
        bundleId: TARGET_ID,
        logicalBytes: new Uint8Array([2]),
      });
      const objects = mergeObjects(base, target);
      const targetAssetUri = [...target.objects.keys()].find(
        (storageUri) => storageUri !== target.bundle.manifestStorageUri,
      )!;
      const oversizedUri =
        kind === "manifest"
          ? target.bundle.manifestStorageUri!
          : targetAssetUri;
      const cancel = vi.fn();
      const get = vi.fn<NonNullable<StoragePlugin["get"]>>(
        async ({ storageUri }) => ({
          response:
            storageUri === oversizedUri
              ? new Response(new ReadableStream({ cancel }), {
                  headers: { "content-length": String(limit + 1) },
                })
              : objects.has(storageUri)
                ? new Response(objects.get(storageUri))
                : null,
        }),
      );
      const databasePlugin = await createDatabasePlugin([
        base.bundle,
        target.bundle,
      ]);
      const publish = vi.spyOn(databasePlugin.models.bundlePatches, "publish");
      const storage = createStorage(objects, { get });

      await expect(
        createBundleDiff(
          { baseBundleId: BASE_ID, bundleId: TARGET_ID },
          { databasePlugin, storagePlugin: storage.plugin },
        ),
      ).rejects.toThrow("byte limit");
      expect(cancel).toHaveBeenCalledOnce();
      expect(hdiff).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("stops Brotli expansion at the logical asset limit", async () => {
    const compressed = new Uint8Array(
      brotliCompressSync(new Uint8Array(1_025)),
    );

    await expect(decompressBrotliBytes(compressed, 1_024)).rejects.toThrow(
      "byte limit",
    );
    expect(hdiff).not.toHaveBeenCalled();
  });

  it("rejects an oversized generated patch before upload or publication", async () => {
    const base = createStoredManifest({
      bundleId: BASE_ID,
      logicalBytes: new Uint8Array([1]),
    });
    const target = createStoredManifest({
      bundleId: TARGET_ID,
      logicalBytes: new Uint8Array([2]),
    });
    const databasePlugin = await createDatabasePlugin([
      base.bundle,
      target.bundle,
    ]);
    const publish = vi.spyOn(databasePlugin.models.bundlePatches, "publish");
    const storage = createStorage(mergeObjects(base, target));
    vi.mocked(hdiff).mockResolvedValueOnce({
      byteLength: MAX_BUNDLE_ARTIFACT_BYTES + 1,
    } as unknown as Awaited<ReturnType<typeof hdiff>>);

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { databasePlugin, storagePlugin: storage.plugin },
      ),
    ).rejects.toThrow("Build artifact exceeds");
    expect(storage.put).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
