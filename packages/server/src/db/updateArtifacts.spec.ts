import { NIL_UUID, type Bundle } from "@hot-updater/core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createArtifactResolver } from "./releaseCatalog";
import { resolveManifestArtifacts } from "./updateArtifacts";

type TestManifestAsset = {
  downloadByteSize?: unknown;
  downloadFileHash?: unknown;
  fileHash: string;
};

const CURRENT_BUNDLE_ID = "00000000-0000-0000-0000-000000000101";
const TARGET_BUNDLE_ID = "00000000-0000-0000-0000-000000000102";
const CURRENT_MANIFEST_URI = `s3://test-bucket/bundles/${CURRENT_BUNDLE_ID}/manifest.json`;
const TARGET_MANIFEST_URI = `s3://test-bucket/bundles/${TARGET_BUNDLE_ID}/manifest.json`;
const PATCH_STORAGE_URI = `s3://test-bucket/bundles/${TARGET_BUNDLE_ID}/patches/${CURRENT_BUNDLE_ID}/patch.bsdiff`;
const VALID_DOWNLOAD_FILE_HASH = "a".repeat(64);

const getUtf8ByteSize = (value: string) =>
  new TextEncoder().encode(value).byteLength;

const createBundle = (
  id: string,
  archiveByteSize: number,
  overrides: Partial<Bundle> = {},
): Bundle => ({
  archiveByteSize,
  assetBaseStorageUri: "s3://test-bucket/assets",
  fileHash: `${id}-archive-hash`,
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
  patchByteSize,
  resolveUrl,
  targetAsset,
  targetManifestSuffix = "",
}: {
  archiveByteSize: number | ((manifestByteSize: number) => number);
  archiveUrlUsable?: boolean;
  assetPath?: string;
  patchByteSize?: unknown;
  resolveUrl?: (storageUri: string) => Promise<string | null>;
  targetAsset: TestManifestAsset;
  targetManifestSuffix?: string;
}) {
  const currentManifestText = JSON.stringify({
    assets: {
      [assetPath]: {
        fileHash: "current-file-hash",
      },
    },
    bundleId: CURRENT_BUNDLE_ID,
  });
  const targetManifestText = `${JSON.stringify({
    assets: {
      [assetPath]: targetAsset,
    },
    bundleId: TARGET_BUNDLE_ID,
  })}${targetManifestSuffix}`;
  const manifestByteSize = getUtf8ByteSize(targetManifestText);
  const resolvedArchiveByteSize =
    typeof archiveByteSize === "function"
      ? archiveByteSize(manifestByteSize)
      : archiveByteSize;
  const hasPatch = patchByteSize !== undefined;
  const currentBundle = createBundle(CURRENT_BUNDLE_ID, 1_024);
  const targetBundle = createBundle(
    TARGET_BUNDLE_ID,
    resolvedArchiveByteSize,
    hasPatch
      ? {
          patches: [
            {
              baseBundleId: CURRENT_BUNDLE_ID,
              baseFileHash: "current-file-hash",
              byteSize: patchByteSize as number,
              patchFileHash: "patch-file-hash",
              patchStorageUri: PATCH_STORAGE_URI,
            },
          ],
        }
      : {},
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
        fileHash: "target-file-hash",
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
        downloadFileHash: VALID_DOWNLOAD_FILE_HASH,
        fileHash: "target-file-hash",
      },
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it("treats an invalid present hash on a raw asset as unknown cost", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: 1,
      assetPath: "assets/logo.png",
      targetAsset: {
        downloadByteSize: 100,
        downloadFileHash: "INVALID",
        fileHash: "target-file-hash",
      },
    });

    expect(result).not.toBeNull();
    expect(resolveFileUrl).toHaveBeenCalledWith(
      "s3://test-bucket/assets/sha256/ta/target-file-hash.png",
    );
  });

  it.each([
    ["missing", undefined],
    ["invalid", "INVALID"],
  ])(
    "treats a Brotli asset as unknown cost when its download hash is %s",
    async (_label, downloadFileHash) => {
      const { resolveFileUrl, result } = await runScenario({
        archiveByteSize: 1,
        targetAsset: {
          downloadByteSize: 100,
          downloadFileHash,
          fileHash: "target-file-hash",
        },
      });

      expect(result).not.toBeNull();
      expect(resolveFileUrl).toHaveBeenCalledWith(
        "s3://test-bucket/assets/sha256/ta/target-file-hash.br",
      );
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
          downloadFileHash: VALID_DOWNLOAD_FILE_HASH,
          fileHash: "target-file-hash",
        },
      });

      expect(result?.changedAssets?.["index.ios.bundle"]?.patch).toEqual(
        expectsPatch
          ? expect.objectContaining({ patchUrl: expect.any(String) })
          : undefined,
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
        downloadFileHash: VALID_DOWNLOAD_FILE_HASH,
        fileHash: "target-file-hash",
      },
    });

    expect(result?.changedAssets?.["index.ios.bundle"]).toEqual({
      fileHash: "target-file-hash",
      patch: expect.objectContaining({
        patchUrl: expect.any(String),
      }),
    });
  });

  it("recalculates from the file when an unknown-size patch URL is unavailable", async () => {
    const { resolveFileUrl, result } = await runScenario({
      archiveByteSize: (manifestByteSize) => manifestByteSize + 50,
      patchByteSize: Number.NaN,
      resolveUrl: async (storageUri) =>
        storageUri === PATCH_STORAGE_URI
          ? null
          : `https://download.example.com/${encodeURIComponent(storageUri)}`,
      targetAsset: {
        downloadByteSize: 100,
        downloadFileHash: VALID_DOWNLOAD_FILE_HASH,
        fileHash: "target-file-hash",
      },
    });

    expect(result).toBeNull();
    expect(resolveFileUrl).toHaveBeenCalledWith(PATCH_STORAGE_URI);
    expect(resolveFileUrl).toHaveBeenCalledWith(
      `s3://test-bucket/assets/sha256/aa/${VALID_DOWNLOAD_FILE_HASH}.br`,
    );
  });

  it("recalculates from a known patch when the file fallback cost is unknown", async () => {
    const { result } = await runScenario({
      archiveByteSize: (manifestByteSize) => manifestByteSize + 50,
      patchByteSize: 100,
      targetAsset: {
        downloadByteSize: 100,
        fileHash: "target-file-hash",
      },
    });

    expect(result).toBeNull();
  });

  it("keeps the manifest path when safe addition overflows", async () => {
    const { result } = await runScenario({
      archiveByteSize: 1,
      assetPath: "assets/logo.png",
      targetAsset: {
        downloadByteSize: Number.MAX_SAFE_INTEGER,
        fileHash: "target-file-hash",
      },
    });

    expect(result).not.toBeNull();
  });

  it("keeps the manifest path when a byte size is invalid", async () => {
    const { result } = await runScenario({
      archiveByteSize: 1,
      assetPath: "assets/logo.png",
      targetAsset: {
        downloadByteSize: -1,
        fileHash: "target-file-hash",
      },
    });

    expect(result).not.toBeNull();
  });

  it("does not select archive when its URL is unavailable", async () => {
    const { result } = await runScenario({
      archiveByteSize: 1,
      archiveUrlUsable: false,
      assetPath: "assets/logo.png",
      targetAsset: {
        downloadByteSize: 100,
        fileHash: "target-file-hash",
      },
    });

    expect(result).not.toBeNull();
  });
});

describe("createArtifactResolver", () => {
  it("returns usable manifest artifacts when the archive URL is null", async () => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    const targetManifestText = JSON.stringify({
      assets: {
        "assets/logo.png": {
          downloadByteSize: 100,
          fileHash: "target-file-hash",
        },
      },
      bundleId: TARGET_BUNDLE_ID,
    });
    const targetBundle = createBundle(TARGET_BUNDLE_ID, 1);
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
          fileHash: "target-file-hash",
        },
      },
      fileUrl: null,
      manifestUrl: expect.any(String),
    });
  });
});
