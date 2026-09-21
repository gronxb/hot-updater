import { NIL_UUID, type Bundle } from "@hot-updater/core";
import {
  createDatabasePlugin,
  createDatabaseClient,
  MAX_BUNDLE_ARCHIVE_BYTES,
  MAX_BUNDLE_ARTIFACT_BYTES,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { getSha256 } from "./bundleManifestValidation";
import { createArtifactResolver } from "./releaseCatalog";
import { resolveManifestArtifacts } from "./updateArtifacts";

type TestManifestAsset = {
  downloadByteSize?: unknown;
  downloadCompression?: "br" | null;
  downloadFileHash?: unknown;
  fileHash: string;
};

const CURRENT_BUNDLE_ID = "00000000-0000-0000-0000-000000000101";
const TARGET_BUNDLE_ID = "00000000-0000-0000-0000-000000000102";
const CURRENT_MANIFEST_URI = `s3://test-bucket/bundles/${CURRENT_BUNDLE_ID}/manifest.json`;
const TARGET_MANIFEST_URI = `s3://test-bucket/bundles/${TARGET_BUNDLE_ID}/manifest.json`;
const PATCH_STORAGE_URI = `s3://test-bucket/bundles/${TARGET_BUNDLE_ID}/patches/${CURRENT_BUNDLE_ID}/patch.bsdiff`;
const VALID_DOWNLOAD_FILE_HASH = "a".repeat(64);
const CURRENT_FILE_HASH = "b".repeat(64);
const TARGET_FILE_HASH = "c".repeat(64);
const DIFFERENT_FILE_HASH = "d".repeat(64);
const MISLEADING_OLD_FILE_HASH = "e".repeat(64);
const MISLEADING_NEW_FILE_HASH = "f".repeat(64);
const PATCH_FILE_HASH = "1".repeat(64);

const getUtf8ByteSize = (value: string) =>
  new TextEncoder().encode(value).byteLength;

const createBundle = (
  id: string,
  archiveByteSize: number,
  overrides: Partial<Bundle> = {},
): Bundle => ({
  archiveByteSize,
  assetBaseStorageUri: "s3://test-bucket/assets",
  fileHash: getSha256(`${id}-archive`),
  gitCommitHash: null,
  id,
  manifestFileHash: `${id}-manifest-hash`,
  manifestStorageUri:
    id === CURRENT_BUNDLE_ID ? CURRENT_MANIFEST_URI : TARGET_MANIFEST_URI,
  platform: "ios",
  storageUri: `s3://test-bucket/bundles/${id}/bundle.zip`,
  ...overrides,
});

async function runScenario({
  archiveByteSize,
  archiveUrlUsable = true,
  assetPath = "index.ios.bundle",
  currentAssetFileHash = CURRENT_FILE_HASH,
  currentManifestBundleId = CURRENT_BUNDLE_ID,
  currentPatchAssetPath,
  currentPlatform = "ios",
  extraCurrentAssets = {},
  extraTargetAssets = {},
  patchBaseFileHash = CURRENT_FILE_HASH,
  patchByteSize,
  patchFileHash = PATCH_FILE_HASH,
  resolveUrl,
  targetAsset,
  targetManifestBundleId = TARGET_BUNDLE_ID,
  targetPatchAssetPath,
  targetManifestSuffix = "",
}: {
  archiveByteSize: number | ((manifestByteSize: number) => number);
  archiveUrlUsable?: boolean;
  assetPath?: string;
  currentAssetFileHash?: string;
  currentManifestBundleId?: string;
  currentPatchAssetPath?: string | null;
  currentPlatform?: Bundle["platform"];
  extraCurrentAssets?: Record<string, TestManifestAsset>;
  extraTargetAssets?: Record<string, TestManifestAsset>;
  patchBaseFileHash?: string;
  patchByteSize?: unknown;
  patchFileHash?: string;
  resolveUrl?: (storageUri: string) => Promise<string | null>;
  targetAsset: TestManifestAsset;
  targetManifestBundleId?: string;
  targetPatchAssetPath?: string | null;
  targetManifestSuffix?: string;
}) {
  const hasPatch = patchByteSize !== undefined;
  const resolvedCurrentPatchAssetPath =
    currentPatchAssetPath === undefined
      ? hasPatch
        ? assetPath
        : null
      : currentPatchAssetPath;
  const resolvedTargetPatchAssetPath =
    targetPatchAssetPath === undefined
      ? hasPatch
        ? assetPath
        : null
      : targetPatchAssetPath;
  const currentManifestText = JSON.stringify({
    assets: {
      [assetPath]: {
        downloadCompression: targetAsset.downloadCompression,
        fileHash: currentAssetFileHash,
      },
      ...extraCurrentAssets,
    },
    bundleId: currentManifestBundleId,
    ...(resolvedCurrentPatchAssetPath
      ? { patchAssetPath: resolvedCurrentPatchAssetPath }
      : {}),
  });
  const targetManifestText = `${JSON.stringify({
    assets: {
      [assetPath]: targetAsset,
      ...extraTargetAssets,
    },
    bundleId: targetManifestBundleId,
    ...(resolvedTargetPatchAssetPath
      ? { patchAssetPath: resolvedTargetPatchAssetPath }
      : {}),
  })}${targetManifestSuffix}`;
  const manifestByteSize = getUtf8ByteSize(targetManifestText);
  const resolvedArchiveByteSize =
    typeof archiveByteSize === "function"
      ? archiveByteSize(manifestByteSize)
      : archiveByteSize;
  const currentBundle = createBundle(CURRENT_BUNDLE_ID, 1_024, {
    manifestFileHash: getSha256(currentManifestText),
    platform: currentPlatform,
  });
  const targetBundle = createBundle(
    TARGET_BUNDLE_ID,
    resolvedArchiveByteSize,
    hasPatch
      ? {
          manifestFileHash: getSha256(targetManifestText),
          patches: [
            {
              baseBundleId: CURRENT_BUNDLE_ID,
              baseFileHash: patchBaseFileHash,
              byteSize: patchByteSize as number,
              patchFileHash,
              patchStorageUri: PATCH_STORAGE_URI,
            },
          ],
        }
      : { manifestFileHash: getSha256(targetManifestText) },
  );
  const storageTexts = new Map([
    [CURRENT_MANIFEST_URI, currentManifestText],
    [TARGET_MANIFEST_URI, targetManifestText],
  ]);
  const resolveFileUrl = vi.fn(async (storageUri: string | null) => {
    if (!storageUri) return null;
    if (resolveUrl) return resolveUrl(storageUri);
    return `https://download.example.com/${encodeURIComponent(storageUri)}`;
  });

  const result = await resolveManifestArtifacts({
    archiveUrlUsable,
    currentBundle,
    readStorageText: async (storageUri) => storageTexts.get(storageUri) ?? null,
    resolveFileUrl,
    targetBundle,
  });

  return {
    manifestByteSize,
    resolveFileUrl,
    result,
  };
}

describe("resolveManifestArtifacts", () => {
  it("uses raw UTF-8 manifest bytes and selects archive at equal size", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: (manifestByteSize) => manifestByteSize + 7,
      assetPath: "assets/한글.png",
      targetAsset: {
        downloadByteSize: 7,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
      targetManifestSuffix: "\n",
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it("accepts a valid download hash and size pair on a raw asset", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: (manifestByteSize) => manifestByteSize + 7,
      assetPath: "assets/logo.png",
      targetAsset: {
        downloadByteSize: 7,
        downloadCompression: null,
        downloadFileHash: VALID_DOWNLOAD_FILE_HASH,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it("uses archive fallback for a malformed raw download hash", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: 1,
      assetPath: "assets/logo.png",
      targetAsset: {
        downloadByteSize: 100,
        downloadCompression: null,
        downloadFileHash: "INVALID",
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined, false],
    ["invalid", "INVALID", true],
  ])(
    "handles a Brotli asset whose download hash is %s",
    async (_label, downloadFileHash, expectsArchiveFallback) => {
      const { resolveFileUrl, result } = await runScenario({
        archiveByteSize: 1,
        targetAsset: {
          downloadByteSize: 100,
          downloadCompression: "br",
          downloadFileHash,
          fileHash: TARGET_FILE_HASH,
        },
      });

      if (expectsArchiveFallback) {
        expect(result).toBeNull();
        expect(resolveFileUrl).not.toHaveBeenCalled();
      } else {
        expect(result).not.toBeNull();
        expect(resolveFileUrl).toHaveBeenCalledWith(
          `s3://test-bucket/assets/sha256/cc/${TARGET_FILE_HASH}.br`,
        );
      }
    },
  );

  it("uses archive fallback for a malformed signed manifest token", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const manifestText = JSON.stringify({
      assets: {
        "runtime/entry.data": {
          downloadByteSize: 3,
          downloadCompression: null,
          fileHash: TARGET_FILE_HASH,
        },
      },
      bundleId: TARGET_BUNDLE_ID,
    });
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 512, {
      manifestFileHash: "sig:",
      metadata: { manifest_content_hash: getSha256(manifestText) },
    });
    await database.insertBundle(targetBundle);
    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async () => manifestText,
      resolveFileUrl: async (storageUri) =>
        storageUri ? `https://download.example.com/${storageUri}` : null,
    });

    await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toEqual({
      fileHash: targetBundle.fileHash,
      fileUrl: `https://download.example.com/${targetBundle.storageUri}`,
    });
  });

  it.each([
    ["is missing", undefined],
    ["does not match", "0".repeat(64)],
  ])(
    "uses archive fallback when a signed manifest content hash %s",
    async (_label, contentHash) => {
      const databasePlugin = createInMemoryDatabasePlugin();
      const database = createDatabaseClient(databasePlugin);
      const manifestText = JSON.stringify({
        assets: {
          "runtime/entry.data": {
            downloadByteSize: 3,
            downloadCompression: null,
            fileHash: TARGET_FILE_HASH,
          },
        },
        bundleId: TARGET_BUNDLE_ID,
      });
      const targetBundle = createBundle(TARGET_BUNDLE_ID, 512, {
        manifestFileHash: "sig:dGVzdC1zaWduYXR1cmU=",
        metadata: contentHash ? { manifest_content_hash: contentHash } : {},
      });
      await database.insertBundle(targetBundle);
      const resolver = createArtifactResolver({
        database: databasePlugin,
        readStorageText: async () => manifestText,
        resolveFileUrl: async (storageUri) =>
          storageUri ? `https://download.example.com/${storageUri}` : null,
      });

      await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toEqual({
        fileHash: targetBundle.fileHash,
        fileUrl: `https://download.example.com/${targetBundle.storageUri}`,
      });
    },
  );

  it.each([
    ["keeps", 9, true],
    ["omits", 10, false],
  ])(
    "%s a %i-byte patch when the file is 10 bytes",
    async (_action, patchByteSize, expectsPatch) => {
      const { resolveFileUrl, result } = await runScenario({
        archiveByteSize: (manifestByteSize) => manifestByteSize + 1_000,
        patchByteSize,
        targetAsset: {
          downloadByteSize: 10,
          downloadCompression: "br",
          downloadFileHash: VALID_DOWNLOAD_FILE_HASH,
          fileHash: TARGET_FILE_HASH,
        },
      });

      expect(result?.changedAssets?.["index.ios.bundle"]?.patch).toEqual(
        expectsPatch
          ? expect.objectContaining({ patchUrl: expect.any(String) })
          : null,
      );
      expect(resolveFileUrl).toHaveBeenCalledWith(
        `s3://test-bucket/assets/sha256/aa/${VALID_DOWNLOAD_FILE_HASH}.br`,
      );
      expect(resolveFileUrl).toHaveBeenCalledWith(PATCH_STORAGE_URI);
    },
  );

  it("keeps a larger patch when the file and archive URLs are unavailable", async () => {
    const fileStorageUri = `s3://test-bucket/assets/sha256/aa/${VALID_DOWNLOAD_FILE_HASH}.br`;
    const { result } = await runScenario({
      archiveByteSize: 1,
      archiveUrlUsable: false,
      patchByteSize: 100,
      resolveUrl: async (storageUri) =>
        storageUri === fileStorageUri
          ? null
          : `https://download.example.com/${encodeURIComponent(storageUri)}`,
      targetAsset: {
        downloadByteSize: 50,
        downloadCompression: "br",
        downloadFileHash: VALID_DOWNLOAD_FILE_HASH,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result?.changedAssets?.["index.ios.bundle"]).toEqual({
      file: null,
      fileHash: TARGET_FILE_HASH,
      patch: expect.objectContaining({
        patchUrl: expect.any(String),
      }),
    });
  });

  it("ignores an invalid-size patch and selects the smaller archive", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: (manifestByteSize) => manifestByteSize + 50,
      patchByteSize: Number.NaN,
      resolveUrl: async (storageUri) =>
        storageUri === PATCH_STORAGE_URI
          ? null
          : `https://download.example.com/${encodeURIComponent(storageUri)}`,
      targetAsset: {
        downloadByteSize: 100,
        downloadCompression: "br",
        downloadFileHash: VALID_DOWNLOAD_FILE_HASH,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it("falls back to the complete asset when patch URL resolution fails", async () => {
    const { result } = await runScenario({
      archiveByteSize: 10_000,
      patchByteSize: 4,
      resolveUrl: async (storageUri) => {
        if (storageUri === PATCH_STORAGE_URI) {
          throw new Error("patch storage unavailable");
        }
        return `https://download.example.com/${encodeURIComponent(storageUri)}`;
      },
      targetAsset: {
        downloadByteSize: 10,
        downloadCompression: "br",
        downloadFileHash: VALID_DOWNLOAD_FILE_HASH,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result?.changedAssets?.["index.ios.bundle"]).toEqual({
      file: {
        compression: "br",
        url: expect.any(String),
      },
      fileHash: TARGET_FILE_HASH,
      patch: null,
    });
  });

  it("recalculates from a known patch when the file fallback cost is unknown", async () => {
    const { result } = await runScenario({
      archiveByteSize: (manifestByteSize) => manifestByteSize + 50,
      patchByteSize: 100,
      targetAsset: {
        downloadByteSize: 100,
        downloadCompression: "br",
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).toBeNull();
  });

  it("uses archive fallback for oversized asset metadata", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: 1,
      assetPath: "assets/logo.png",
      targetAsset: {
        downloadByteSize: MAX_BUNDLE_ARTIFACT_BYTES + 1,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it("uses archive fallback for oversized patch metadata", async () => {
    const { result } = await runScenario({
      archiveByteSize: 1,
      patchByteSize: MAX_BUNDLE_ARTIFACT_BYTES + 1,
      targetAsset: {
        downloadByteSize: 100,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).toBeNull();
  });

  it.each([
    ["base", { patchBaseFileHash: "malformed" }],
    ["patch", { patchFileHash: "malformed" }],
  ])(
    "uses archive fallback for a malformed stored %s hash",
    async (_, extra) => {
      const { resolveFileUrl, result } = await runScenario({
        archiveByteSize: 1,
        patchByteSize: 4,
        targetAsset: {
          downloadByteSize: 100,
          downloadCompression: null,
          fileHash: TARGET_FILE_HASH,
        },
        ...extra,
      });

      expect(result).toBeNull();
      expect(resolveFileUrl).not.toHaveBeenCalled();
    },
  );

  it("uses archive fallback when a byte size is invalid", async () => {
    const { result } = await runScenario({
      archiveByteSize: 1,
      assetPath: "assets/logo.png",
      targetAsset: {
        downloadByteSize: -1,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).toBeNull();
  });

  it("does not select archive when its URL is unavailable", async () => {
    const { result } = await runScenario({
      archiveByteSize: 1,
      archiveUrlUsable: false,
      assetPath: "assets/logo.png",
      targetAsset: {
        downloadByteSize: 100,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).not.toBeNull();
  });

  it("uses an opaque declared patch entry and ignores a misleading .bundle asset", async () => {
    const { result } = await runScenario({
      archiveByteSize: 10_000,
      assetPath: "runtime/entry.lynxbc",
      extraCurrentAssets: {
        "index.ios.bundle": {
          downloadCompression: null,
          fileHash: MISLEADING_OLD_FILE_HASH,
        },
      },
      extraTargetAssets: {
        "index.ios.bundle": {
          downloadByteSize: 12,
          downloadCompression: null,
          fileHash: MISLEADING_NEW_FILE_HASH,
        },
      },
      patchByteSize: 4,
      targetAsset: {
        downloadByteSize: 20,
        downloadCompression: "br",
        downloadFileHash: VALID_DOWNLOAD_FILE_HASH,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result?.changedAssets?.["runtime/entry.lynxbc"]).toMatchObject({
      file: { compression: "br" },
      patch: { algorithm: "bsdiff" },
    });
    expect(result?.changedAssets?.["index.ios.bundle"]?.patch).toBeNull();
    expect(result?.changedAssets?.["index.ios.bundle"]?.file).toMatchObject({
      compression: null,
    });
  });

  it("returns explicit null compression for a declared raw asset", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: 10_000,
      assetPath: "runtime/entry.data",
      targetAsset: {
        downloadByteSize: 8,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result?.changedAssets?.["runtime/entry.data"]?.file).toEqual({
      compression: null,
      url: expect.any(String),
    });
    expect(resolveFileUrl).toHaveBeenCalledWith(
      `s3://test-bucket/assets/sha256/cc/${TARGET_FILE_HASH}.data`,
    );
  });

  it("uses archive fallback for a legacy target manifest without explicit compression", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: 10_000,
      targetAsset: {
        downloadByteSize: 8,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "patch entry paths disagree",
      overrides: {
        currentPatchAssetPath: "runtime/base.data",
        extraCurrentAssets: {
          "runtime/base.data": {
            downloadCompression: null,
            fileHash: CURRENT_FILE_HASH,
          },
        },
      },
    },
    {
      label: "recorded base hash disagrees with the base manifest",
      overrides: {
        currentAssetFileHash: DIFFERENT_FILE_HASH,
      },
    },
  ])("omits the patch when $label", async ({ overrides }) => {
    const { result } = await runScenario({
      archiveByteSize: 10_000,
      assetPath: "runtime/entry.data",
      patchByteSize: 4,
      targetAsset: {
        downloadByteSize: 8,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
      ...overrides,
    });

    expect(result?.changedAssets?.["runtime/entry.data"]?.file).toEqual({
      compression: null,
      url: expect.any(String),
    });
    expect(result?.changedAssets?.["runtime/entry.data"]?.patch).toBeNull();
  });

  it("uses archive fallback when the declared patch entry is not in the manifest", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: 10_000,
      assetPath: "runtime/entry.data",
      patchByteSize: 4,
      targetAsset: {
        downloadByteSize: 8,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
      targetPatchAssetPath: "runtime/missing.data",
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it("uses archive fallback before resolving an asset with a noncanonical path", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: 10_000,
      assetPath: "../outside.bin",
      patchByteSize: 4,
      targetAsset: {
        downloadByteSize: 8,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it("uses archive fallback when the target manifest names another bundle", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: 10_000,
      targetAsset: {
        downloadByteSize: 8,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
      targetManifestBundleId: CURRENT_BUNDLE_ID,
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it("does not reuse assets from a current bundle on another platform", async () => {
    const { result } = await runScenario({
      archiveByteSize: 10_000,
      assetPath: "runtime/entry.data",
      currentAssetFileHash: TARGET_FILE_HASH,
      currentPlatform: "android",
      targetAsset: {
        downloadByteSize: 8,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result?.changedAssets?.["runtime/entry.data"]).toMatchObject({
      file: { compression: null },
      fileHash: TARGET_FILE_HASH,
    });
  });

  it("uses archive fallback when neither the patch nor complete file URL can be resolved", async () => {
    const { result } = await runScenario({
      archiveByteSize: 10_000,
      assetPath: "runtime/entry.data",
      patchByteSize: 4,
      resolveUrl: async (storageUri) => {
        if (
          storageUri === PATCH_STORAGE_URI ||
          storageUri.startsWith("s3://test-bucket/assets/")
        ) {
          throw new Error("storage unavailable");
        }
        return `https://download.example.com/${encodeURIComponent(storageUri)}`;
      },
      targetAsset: {
        downloadByteSize: 8,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(result).toBeNull();
  });

  it("bounds asset URL resolution concurrency while preserving manifest order", async () => {
    const extraTargetAssets = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `assets/item-${index.toString().padStart(2, "0")}.bin`,
        {
          downloadByteSize: 1,
          downloadCompression: null,
          fileHash: TARGET_FILE_HASH,
        },
      ]),
    );
    let active = 0;
    let maximumActive = 0;
    const { result } = await runScenario({
      archiveByteSize: 100_000,
      assetPath: "runtime/entry.data",
      extraTargetAssets,
      resolveUrl: async (storageUri) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return `https://download.example.com/${encodeURIComponent(storageUri)}`;
      },
      targetAsset: {
        downloadByteSize: 1,
        downloadCompression: null,
        fileHash: TARGET_FILE_HASH,
      },
    });

    expect(maximumActive).toBeLessThanOrEqual(16);
    expect(Object.keys(result?.changedAssets ?? {})).toEqual([
      "runtime/entry.data",
      ...Object.keys(extraTargetAssets),
    ]);
  });
});

describe("createArtifactResolver", () => {
  it("does not resolve an oversized archive", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const targetBundle = createBundle(
      TARGET_BUNDLE_ID,
      MAX_BUNDLE_ARCHIVE_BYTES + 1,
    );
    await database.insertBundle(targetBundle);
    const resolveFileUrl = vi.fn(async () => "https://download.example.com");
    const resolver = createArtifactResolver({
      database: databasePlugin,
      resolveFileUrl,
    });

    await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["byte size", MAX_BUNDLE_ARTIFACT_BYTES + 1, 0],
    ["order index", 1, -1],
  ])(
    "ignores a corrupt optional patch %s and keeps archive fallback",
    async (_label, byteSize, orderIndex) => {
      const basePlugin = createInMemoryDatabasePlugin();
      const database = createDatabaseClient(basePlugin);
      const targetBundle = createBundle(TARGET_BUNDLE_ID, 512);
      await database.insertBundle(targetBundle);
      const corruptPlugin = createDatabasePlugin({
        commit: basePlugin.commit,
        name: "corrupt-patch-rows",
        models: {
          ...basePlugin.models,
          bundlePatches: {
            findByBundleIds: async () => [
              {
                base_bundle_id: CURRENT_BUNDLE_ID,
                base_file_hash: CURRENT_FILE_HASH,
                bundle_id: TARGET_BUNDLE_ID,
                byte_size: byteSize,
                id: `${TARGET_BUNDLE_ID}:${CURRENT_BUNDLE_ID}`,
                order_index: orderIndex,
                patch_file_hash: PATCH_FILE_HASH,
                patch_storage_uri: PATCH_STORAGE_URI,
              },
            ],
          },
        },
      });
      const resolver = createArtifactResolver({
        database: corruptPlugin,
        resolveFileUrl: async (storageUri) =>
          storageUri ? `https://download.example.com/${storageUri}` : null,
      });

      await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toEqual({
        fileHash: targetBundle.fileHash,
        fileUrl: `https://download.example.com/${targetBundle.storageUri}`,
      });
    },
  );

  it("uses manifest delivery when archive size metadata is oversized", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const targetManifestText = JSON.stringify({
      assets: {
        "assets/logo.png": {
          downloadByteSize: 100,
          downloadCompression: null,
          fileHash: TARGET_FILE_HASH,
        },
      },
      bundleId: TARGET_BUNDLE_ID,
    });
    const targetBundle = createBundle(
      TARGET_BUNDLE_ID,
      MAX_BUNDLE_ARCHIVE_BYTES + 1,
      { manifestFileHash: getSha256(targetManifestText) },
    );
    await database.insertBundle(targetBundle);
    const resolveFileUrl = vi.fn(async (storageUri: string | null) =>
      storageUri ? `https://download.example.com/${storageUri}` : null,
    );
    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async () => targetManifestText,
      resolveFileUrl,
    });

    await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toMatchObject({
      changedAssets: {
        "assets/logo.png": {
          file: { url: expect.any(String) },
          fileHash: TARGET_FILE_HASH,
        },
      },
      fileHash: null,
      fileUrl: null,
      manifestFileHash: getSha256(targetManifestText),
      manifestUrl: expect.any(String),
    });
    expect(resolveFileUrl).not.toHaveBeenCalledWith(targetBundle.storageUri);
  });

  it("keeps an older publication available through its verified archive", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 512);
    await database.insertBundle(targetBundle);

    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async (storageUri) =>
        storageUri === TARGET_MANIFEST_URI
          ? JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "legacy-file-hash",
                },
              },
              bundleId: TARGET_BUNDLE_ID,
            })
          : null,
      resolveFileUrl: async (storageUri) =>
        storageUri
          ? `https://download.example.com/${encodeURIComponent(storageUri)}`
          : null,
    });

    await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toEqual({
      fileHash: targetBundle.fileHash,
      fileUrl: `https://download.example.com/${encodeURIComponent(targetBundle.storageUri)}`,
    });
  });

  it("uses archive fallback when reading the target manifest throws", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 512);
    await database.insertBundle(targetBundle);
    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async () => {
        throw new Error("manifest response too large");
      },
      resolveFileUrl: async (storageUri) =>
        storageUri ? `https://download.example.com/${storageUri}` : null,
    });

    await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toEqual({
      fileHash: targetBundle.fileHash,
      fileUrl: `https://download.example.com/${targetBundle.storageUri}`,
    });
  });

  it("does not reuse or patch assets when reading the current manifest throws", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const targetManifestText = JSON.stringify({
      assets: {
        "runtime/entry.data": {
          downloadByteSize: 8,
          downloadCompression: null,
          fileHash: TARGET_FILE_HASH,
        },
      },
      bundleId: TARGET_BUNDLE_ID,
      patchAssetPath: "runtime/entry.data",
    });
    const currentBundle = createBundle(CURRENT_BUNDLE_ID, 512, {
      manifestFileHash: CURRENT_FILE_HASH,
    });
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 10_000, {
      manifestFileHash: getSha256(targetManifestText),
      patches: [
        {
          baseBundleId: CURRENT_BUNDLE_ID,
          baseFileHash: CURRENT_FILE_HASH,
          byteSize: 4,
          patchFileHash: PATCH_FILE_HASH,
          patchStorageUri: PATCH_STORAGE_URI,
        },
      ],
    });
    await database.insertBundle(currentBundle);
    await database.insertBundle(targetBundle);
    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async (storageUri) => {
        if (storageUri === CURRENT_MANIFEST_URI) {
          throw new Error("current manifest unavailable");
        }
        return storageUri === TARGET_MANIFEST_URI ? targetManifestText : null;
      },
      resolveFileUrl: async (storageUri) =>
        storageUri ? `https://download.example.com/${storageUri}` : null,
    });

    await expect(
      resolver(TARGET_BUNDLE_ID, CURRENT_BUNDLE_ID),
    ).resolves.toMatchObject({
      changedAssets: {
        "runtime/entry.data": {
          file: { compression: null, url: expect.any(String) },
          fileHash: TARGET_FILE_HASH,
        },
      },
    });
  });

  it("uses archive fallback when the manifest URL resolution throws", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const manifestText = JSON.stringify({
      assets: {
        "runtime/entry.data": {
          downloadByteSize: 3,
          downloadCompression: null,
          fileHash: TARGET_FILE_HASH,
        },
      },
      bundleId: TARGET_BUNDLE_ID,
    });
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 512, {
      manifestFileHash: getSha256(manifestText),
    });
    await database.insertBundle(targetBundle);
    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async () => manifestText,
      resolveFileUrl: async (storageUri) => {
        if (storageUri === TARGET_MANIFEST_URI) {
          throw new Error("manifest URL unavailable");
        }
        return storageUri ? `https://download.example.com/${storageUri}` : null;
      },
    });

    await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toEqual({
      fileHash: targetBundle.fileHash,
      fileUrl: `https://download.example.com/${targetBundle.storageUri}`,
    });
  });

  it("uses archive fallback when changed asset descriptors exceed the response budget", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const assets = Object.fromEntries(
      Array.from({ length: 4_000 }, (_, index) => [
        `assets/item-${index.toString().padStart(4, "0")}.bin`,
        {
          downloadByteSize: 1,
          downloadCompression: null,
          fileHash: TARGET_FILE_HASH,
        },
      ]),
    );
    const manifestText = JSON.stringify({ assets, bundleId: TARGET_BUNDLE_ID });
    expect(getUtf8ByteSize(manifestText)).toBeLessThan(1024 * 1024);
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 100_000_000, {
      manifestFileHash: getSha256(manifestText),
    });
    await database.insertBundle(targetBundle);
    const resolveFileUrl = vi.fn(async (storageUri: string | null) =>
      storageUri
        ? `https://download.example.com/${encodeURIComponent(storageUri)}`
        : null,
    );
    for (const archiveUrlUsable of [false, true]) {
      await expect(
        resolveManifestArtifacts({
          archiveUrlUsable,
          currentBundle: null,
          readStorageText: async () => manifestText,
          resolveFileUrl,
          targetBundle,
        }),
      ).resolves.toBeNull();
    }
    expect(resolveFileUrl).not.toHaveBeenCalled();
    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async () => manifestText,
      resolveFileUrl,
    });

    const result = await resolver(TARGET_BUNDLE_ID, NIL_UUID);

    expect(result).toEqual({
      fileHash: targetBundle.fileHash,
      fileUrl: `https://download.example.com/${encodeURIComponent(targetBundle.storageUri)}`,
    });
    expect(resolveFileUrl).toHaveBeenCalledOnce();
    expect(resolveFileUrl).toHaveBeenCalledWith(targetBundle.storageUri);
  });

  it("returns no artifact when neither archive nor manifest delivery is usable", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 512);
    await database.insertBundle(targetBundle);
    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async () => null,
      resolveFileUrl: async () => null,
    });

    await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toBeNull();
  });

  it.each([
    ["does not match its database hash", "0".repeat(64), TARGET_FILE_HASH],
    ["contains a malformed asset hash", null, "malformed"],
  ])(
    "uses archive fallback when the stored manifest %s",
    async (_label, databaseHash, assetHash) => {
      const databasePlugin = createInMemoryDatabasePlugin();
      const database = createDatabaseClient(databasePlugin);
      const manifestText = JSON.stringify({
        assets: {
          "runtime/entry.data": {
            downloadByteSize: 3,
            downloadCompression: null,
            fileHash: assetHash,
          },
        },
        bundleId: TARGET_BUNDLE_ID,
      });
      const targetBundle = createBundle(TARGET_BUNDLE_ID, 512, {
        manifestFileHash: databaseHash ?? getSha256(manifestText),
      });
      await database.insertBundle(targetBundle);
      const resolveFileUrl = vi.fn(async (storageUri: string | null) =>
        storageUri ? `https://download.example.com/${storageUri}` : null,
      );
      const resolver = createArtifactResolver({
        database: databasePlugin,
        readStorageText: async (storageUri) =>
          storageUri === TARGET_MANIFEST_URI ? manifestText : null,
        resolveFileUrl,
      });

      await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toEqual({
        fileHash: targetBundle.fileHash,
        fileUrl: `https://download.example.com/${targetBundle.storageUri}`,
      });
      expect(resolveFileUrl).toHaveBeenCalledOnce();
      expect(resolveFileUrl).toHaveBeenCalledWith(targetBundle.storageUri);
    },
  );

  it("returns usable manifest artifacts when the archive URL is null", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const targetManifestText = JSON.stringify({
      assets: {
        "assets/logo.png": {
          downloadByteSize: 100,
          downloadCompression: null,
          fileHash: TARGET_FILE_HASH,
        },
      },
      bundleId: TARGET_BUNDLE_ID,
    });
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 1, {
      manifestFileHash: "sig:dGVzdC1zaWduYXR1cmU=",
      metadata: { manifest_content_hash: getSha256(targetManifestText) },
    });
    await database.insertBundle(targetBundle);

    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async (storageUri) =>
        storageUri === TARGET_MANIFEST_URI ? targetManifestText : null,
      resolveFileUrl: async (storageUri) =>
        storageUri === targetBundle.storageUri
          ? null
          : `https://download.example.com/${encodeURIComponent(storageUri ?? "")}`,
    });

    await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toMatchObject({
      changedAssets: {
        "assets/logo.png": {
          file: { url: expect.any(String) },
          fileHash: TARGET_FILE_HASH,
        },
      },
      fileHash: null,
      fileUrl: null,
      manifestFileHash: "sig:dGVzdC1zaWduYXR1cmU=",
      manifestUrl: expect.any(String),
    });
  });

  it("returns usable manifest artifacts when archive URL resolution throws", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const targetManifestText = JSON.stringify({
      assets: {
        "assets/logo.png": {
          downloadByteSize: 100,
          downloadCompression: null,
          fileHash: TARGET_FILE_HASH,
        },
      },
      bundleId: TARGET_BUNDLE_ID,
    });
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 1, {
      manifestFileHash: getSha256(targetManifestText),
    });
    await database.insertBundle(targetBundle);

    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async (storageUri) =>
        storageUri === TARGET_MANIFEST_URI ? targetManifestText : null,
      resolveFileUrl: async (storageUri) => {
        if (storageUri === targetBundle.storageUri) {
          throw new Error("archive URL unavailable");
        }
        return `https://download.example.com/${encodeURIComponent(storageUri ?? "")}`;
      },
    });

    await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toMatchObject({
      changedAssets: {
        "assets/logo.png": {
          file: { url: expect.any(String) },
          fileHash: TARGET_FILE_HASH,
        },
      },
      fileHash: null,
      fileUrl: null,
      manifestFileHash: getSha256(targetManifestText),
      manifestUrl: expect.any(String),
    });
  });

  it("uses manifest delivery when the stored archive hash is malformed", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const targetManifestText = JSON.stringify({
      assets: {
        "assets/logo.png": {
          downloadByteSize: 100,
          downloadCompression: null,
          fileHash: TARGET_FILE_HASH,
        },
      },
      bundleId: TARGET_BUNDLE_ID,
    });
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 1, {
      fileHash: "malformed",
      manifestFileHash: getSha256(targetManifestText),
    });
    await database.insertBundle(targetBundle);
    const resolveFileUrl = vi.fn(async (storageUri: string | null) =>
      storageUri
        ? `https://download.example.com/${encodeURIComponent(storageUri)}`
        : null,
    );
    const resolver = createArtifactResolver({
      database: databasePlugin,
      readStorageText: async () => targetManifestText,
      resolveFileUrl,
    });

    await expect(resolver(TARGET_BUNDLE_ID, NIL_UUID)).resolves.toMatchObject({
      changedAssets: {
        "assets/logo.png": {
          file: { url: expect.any(String) },
          fileHash: TARGET_FILE_HASH,
        },
      },
      fileHash: null,
      fileUrl: null,
      manifestFileHash: getSha256(targetManifestText),
      manifestUrl: expect.any(String),
    });
    expect(resolveFileUrl).not.toHaveBeenCalledWith(targetBundle.storageUri);
  });
});
