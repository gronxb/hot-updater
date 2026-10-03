import { brotliCompressSync } from "node:zlib";

import { bsdiff } from "@hot-updater/bsdiff";
import type {
  HotUpdaterCoreApi,
  StorageAdapter,
  StorageAdapterWith,
} from "@hot-updater/plugin-core";
import {
  createMemoryAdapter,
  rowToBundle,
  getSha256,
  createStorageAdapter as createCoreStorageAdapter,
  getManifestAssetDownloadPath,
  MAX_BUNDLE_ARTIFACT_BYTES,
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_PATCHES,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";
import type { Bundle, BundleManifest } from "@hot-updater/protocol";
import { createHotUpdater } from "@hot-updater/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBundleDiff, decompressBrotliBytes } from "./createBundleDiff";

vi.mock("@hot-updater/bsdiff", () => ({
  bsdiff: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
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
  assetBaseStorageUri: ASSET_BASE_URI,
  gitCommitHash: null,
  id,
  manifestFileHash: getSha256(manifestBytes),
  manifestStorageUri: `s3://test-bucket/releases/bundles/${id}/manifest.json`,
  metadata: {},
  platform: "ios",
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

const createCore = async (
  bundles: readonly Bundle[],
  adapter = createMemoryAdapter(),
): Promise<HotUpdaterCoreApi> => {
  const { core } = createHotUpdater({
    database: { name: "memory", adapter },
    clientAccess: "public",
  });
  for (const bundle of bundles)
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
  return core;
};
const readBundle = async (core: HotUpdaterCoreApi, id: string) => {
  const detail = await core.getBundle(id);
  return detail && rowToBundle(detail.bundle, detail.patches);
};

const createStorage = (
  objects: ReadonlyMap<string, Uint8Array>,
  overrides: {
    delete?: NonNullable<StorageAdapter["delete"]>;
    get?: NonNullable<StorageAdapter["get"]>;
    put?: NonNullable<StorageAdapter["put"]>;
  } = {},
) => {
  const get = vi.fn<NonNullable<StorageAdapter["get"]>>(
    overrides.get ??
      (async ({ storageUri }) => ({
        response: objects.has(storageUri)
          ? new Response(Uint8Array.from(objects.get(storageUri)!))
          : null,
      })),
  );
  const put =
    overrides.put ??
    vi.fn<NonNullable<StorageAdapter["put"]>>(async ({ key }) => ({
      storageUri: `s3://test-bucket/${key}`,
    }));
  const remove =
    overrides.delete ??
    vi.fn<NonNullable<StorageAdapter["delete"]>>(async () => ({
      deleted: true,
    }));
  const plugin: StorageAdapterWith<"get" | "put" | "delete"> =
    createCoreStorageAdapter({
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
    const core = await createCore([base.bundle, target.bundle]);
    const publish = vi.spyOn(core, "updateBundle");
    const storage = createStorage(mergeObjects(base, target));

    const result = await createBundleDiff(
      { baseBundleId: BASE_ID, bundleId: TARGET_ID },
      { core, storageAdapter: storage.plugin },
    );

    expect(bsdiff).toHaveBeenCalledWith(
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
    const core = await createCore([first.bundle, second.bundle, third.bundle]);
    const storage = createStorage(mergeObjects(first, second, third));

    await createBundleDiff(
      { baseBundleId: third.bundle.id, bundleId: second.bundle.id },
      { core, storageAdapter: storage.plugin },
    );
    await createBundleDiff(
      { baseBundleId: second.bundle.id, bundleId: first.bundle.id },
      { core, storageAdapter: storage.plugin },
    );

    await expect(readBundle(core, second.bundle.id)).resolves.toMatchObject({
      patches: [expect.objectContaining({ baseBundleId: third.bundle.id })],
    });
    await expect(readBundle(core, first.bundle.id)).resolves.toMatchObject({
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
    const core = await createCore([base.bundle, target.bundle]);
    const storage = createStorage(mergeObjects(base, target));

    await createBundleDiff(
      { baseBundleId: BASE_ID, bundleId: TARGET_ID },
      { core, storageAdapter: storage.plugin },
    );

    expect(bsdiff).toHaveBeenCalledWith(
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
    const core = await createCore([base.bundle, target.bundle]);
    const storage = createStorage(mergeObjects(base, target));

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { core, storageAdapter: storage.plugin },
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
    const core = await createCore([base.bundle, target.bundle]);
    const storage = createStorage(mergeObjects(base, target));

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { core, storageAdapter: storage.plugin },
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
    const legacyDatabase = await createCore([base.bundle, legacyBundle]);
    const legacyStorage = createStorage(
      new Map([
        ...base.objects,
        [legacyBundle.manifestStorageUri!, legacyBytes],
      ]),
    );

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { core: legacyDatabase, storageAdapter: legacyStorage.plugin },
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
      const core = await createCore([base.bundle, targetBundle]);
      const publish = vi.spyOn(core, "updateBundle");
      const storage = createStorage(
        new Map([...base.objects, [targetBundle.manifestStorageUri!, bytes]]),
      );

      await expect(
        createBundleDiff(
          { baseBundleId: BASE_ID, bundleId: TARGET_ID },
          { core, storageAdapter: storage.plugin },
        ),
      ).rejects.toThrow(`Invalid manifest payload for bundle ${TARGET_ID}`);
      expect(storage.get).toHaveBeenCalledTimes(2);
      expect(bsdiff).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

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
    const core = await createCore([base.bundle, target.bundle]);
    const publish = vi.spyOn(core, "updateBundle");
    const storage = createStorage(mergeObjects(base, target));

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { core, storageAdapter: storage.plugin },
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
      const core = await createCore([base.bundle, target.bundle]);
      const publish = vi.spyOn(core, "updateBundle");
      const storage = createStorage(mergeObjects(base, target));

      await expect(
        createBundleDiff(
          { baseBundleId: BASE_ID, bundleId: TARGET_ID },
          { core, storageAdapter: storage.plugin },
        ),
      ).rejects.toThrow("Invalid download representation");
      expect(bsdiff).not.toHaveBeenCalled();
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
    const adapter = createMemoryAdapter();
    const firstCore = await createCore(
      [firstBase.bundle, secondBase.bundle, target.bundle],
      adapter,
    );
    const secondCore = await createCore([], adapter);
    let releaseUploads = () => {};
    const bothUploadsStarted = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    let uploadCount = 0;
    const uploaded = new Set<string>();
    const put = vi.fn<NonNullable<StorageAdapter["put"]>>(async ({ key }) => {
      uploadCount += 1;
      if (uploadCount === 2) releaseUploads();
      await bothUploadsStarted;
      const storageUri = `s3://test-bucket/${key}`;
      uploaded.add(storageUri);
      return { storageUri };
    });
    const remove = vi.fn<NonNullable<StorageAdapter["delete"]>>(
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
        { core: firstCore, storageAdapter: storage.plugin },
      ),
      createBundleDiff(
        { baseBundleId: SECOND_BASE_ID, bundleId: TARGET_ID },
        { core: secondCore, storageAdapter: storage.plugin },
      ),
    ]);

    const persisted = await readBundle(firstCore, TARGET_ID);
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
    const core = await createCore([
      baseBundle,
      ...patchBaseBundles,
      targetBundle,
    ]);
    const publish = vi.spyOn(core, "updateBundle");
    const storage = createStorage(new Map());

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { core, storageAdapter: storage.plugin },
      ),
    ).rejects.toThrow(
      `Target bundle cannot contain more than ${MAX_BUNDLE_PATCHES} patches`,
    );
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
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
    const core = await createCore([base.bundle, target.bundle]);
    vi.spyOn(core, "updateBundle").mockRejectedValue(
      new Error("database unavailable"),
    );
    const remove = vi.fn<NonNullable<StorageAdapter["delete"]>>(async () => ({
      deleted: true,
    }));
    const storage = createStorage(mergeObjects(base, target), {
      delete: remove,
    });

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { core, storageAdapter: storage.plugin },
      ),
    ).rejects.toThrow("database unavailable");
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
    const core = await createCore([base.bundle, target.bundle]);
    const remove = vi.fn<NonNullable<StorageAdapter["delete"]>>(async () => ({
      deleted: true,
    }));
    const storage = createStorage(mergeObjects(base, target), {
      delete: remove,
    });

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { core, storageAdapter: storage.plugin },
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
      const get = vi.fn<NonNullable<StorageAdapter["get"]>>(
        async ({ storageUri }) => ({
          response:
            storageUri === oversizedUri
              ? new Response(new ReadableStream({ cancel }), {
                  headers: { "content-length": String(limit + 1) },
                })
              : objects.has(storageUri)
                ? new Response(Uint8Array.from(objects.get(storageUri)!))
                : null,
        }),
      );
      const core = await createCore([base.bundle, target.bundle]);
      const publish = vi.spyOn(core, "updateBundle");
      const storage = createStorage(objects, { get });

      await expect(
        createBundleDiff(
          { baseBundleId: BASE_ID, bundleId: TARGET_ID },
          { core, storageAdapter: storage.plugin },
        ),
      ).rejects.toThrow("byte limit");
      expect(cancel).toHaveBeenCalledOnce();
      expect(bsdiff).not.toHaveBeenCalled();
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
    expect(bsdiff).not.toHaveBeenCalled();
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
    const core = await createCore([base.bundle, target.bundle]);
    const publish = vi.spyOn(core, "updateBundle");
    const storage = createStorage(mergeObjects(base, target));
    vi.mocked(bsdiff).mockResolvedValueOnce({
      byteLength: MAX_BUNDLE_ARTIFACT_BYTES + 1,
    } as unknown as Awaited<ReturnType<typeof bsdiff>>);

    await expect(
      createBundleDiff(
        { baseBundleId: BASE_ID, bundleId: TARGET_ID },
        { core, storageAdapter: storage.plugin },
      ),
    ).rejects.toThrow("Build artifact exceeds");
    expect(storage.put).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
