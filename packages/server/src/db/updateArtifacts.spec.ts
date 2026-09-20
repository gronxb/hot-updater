import { NIL_UUID, type Bundle } from "@hot-updater/core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createArtifactResolver } from "./releaseCatalog";
import { resolveManifestArtifacts } from "./updateArtifacts";

const CURRENT_ID = "00000000-0000-0000-0000-000000000101";
const TARGET_ID = "00000000-0000-0000-0000-000000000102";
const CURRENT_MANIFEST_URI = `s3://bucket/bundles/${CURRENT_ID}/manifest.json`;
const TARGET_MANIFEST_URI = `s3://bucket/bundles/${TARGET_ID}/manifest.json`;
const PATCH_URI = `s3://bucket/bundles/${TARGET_ID}/patch.bsdiff`;

const createBundle = (id: string, overrides: Partial<Bundle> = {}): Bundle => ({
  id,
  platform: "ios",
  gitCommitHash: null,
  manifestStorageUri:
    id === CURRENT_ID ? CURRENT_MANIFEST_URI : TARGET_MANIFEST_URI,
  manifestFileHash: `manifest-hash-${id}`,
  assetBaseStorageUri: "s3://bucket/assets",
  ...overrides,
});

const runScenario = async ({
  currentHash = "current-hash",
  patchByteSize,
  targetHash = "target-hash",
  targetDownloadByteSize = 10,
  resolveUrl,
}: {
  currentHash?: string;
  patchByteSize?: number;
  targetHash?: string;
  targetDownloadByteSize?: number;
  resolveUrl?: (storageUri: string) => string | null;
} = {}) => {
  const currentBundle = createBundle(CURRENT_ID);
  const targetBundle = createBundle(TARGET_ID, {
    patches:
      patchByteSize === undefined
        ? []
        : [
            {
              baseBundleId: CURRENT_ID,
              baseFileHash: currentHash,
              byteSize: patchByteSize,
              patchFileHash: "patch-hash",
              patchStorageUri: PATCH_URI,
            },
          ],
  });
  const manifests = new Map([
    [
      CURRENT_MANIFEST_URI,
      JSON.stringify({
        bundleId: CURRENT_ID,
        assets: { "index.ios.bundle": { fileHash: currentHash } },
      }),
    ],
    [
      TARGET_MANIFEST_URI,
      JSON.stringify({
        bundleId: TARGET_ID,
        assets: {
          "index.ios.bundle": {
            downloadByteSize: targetDownloadByteSize,
            downloadFileHash: "a".repeat(64),
            fileHash: targetHash,
          },
        },
      }),
    ],
  ]);
  const resolveFileUrl = vi.fn(async (storageUri: string | null) =>
    storageUri
      ? resolveUrl
        ? resolveUrl(storageUri)
        : `https://download.test/${encodeURIComponent(storageUri)}`
      : null,
  );
  const result = await resolveManifestArtifacts({
    currentBundle,
    readStorageText: async (uri) => manifests.get(uri) ?? null,
    resolveFileUrl,
    targetBundle,
  });
  return { resolveFileUrl, result };
};

describe("resolveManifestArtifacts", () => {
  it("returns an original descriptor for every target file, including unchanged files", async () => {
    const { result } = await runScenario({
      currentHash: "same-hash",
      targetHash: "same-hash",
    });

    expect(result).toMatchObject({
      artifactProtocolVersion: 1,
      assets: {
        "index.ios.bundle": {
          file: { compression: "br", url: expect.any(String) },
          fileHash: "same-hash",
        },
      },
    });
  });

  it.each([
    ["keeps", 9, true],
    ["omits", 10, false],
  ])(
    "%s a patch when it is smaller than the original transfer",
    async (_label, patchByteSize, expectsPatch) => {
      const { result } = await runScenario({ patchByteSize });
      expect(result?.assets?.["index.ios.bundle"]?.patch).toEqual(
        expectsPatch
          ? expect.objectContaining({ patchUrl: expect.any(String) })
          : undefined,
      );
    },
  );

  it("fails closed when an original file URL cannot be resolved", async () => {
    const { result } = await runScenario({
      patchByteSize: 1,
      resolveUrl: (uri) => (uri === PATCH_URI ? "https://patch.test" : null),
    });
    expect(result).toBeNull();
  });
});

describe("createArtifactResolver", () => {
  const setup = async (readManifest = true) => {
    const databasePlugin = createInMemoryDatabasePlugin();
    const database = createDatabaseClient(databasePlugin);
    await database.insertBundle(createBundle(TARGET_ID));
    const manifestText = JSON.stringify({
      bundleId: TARGET_ID,
      assets: {
        "assets/logo.png": {
          downloadByteSize: 4,
          fileHash: "logo-hash",
        },
      },
    });
    return createArtifactResolver({
      database: databasePlugin,
      ...(readManifest
        ? {
            readStorageText: async (uri: string) =>
              uri === TARGET_MANIFEST_URI ? manifestText : null,
          }
        : {}),
      resolveFileUrl: async (uri) =>
        uri ? `https://download.test/${encodeURIComponent(uri)}` : null,
    });
  };

  it("serves the explicit manifest artifact protocol", async () => {
    const resolver = await setup();
    await expect(resolver(TARGET_ID, NIL_UUID, 1)).resolves.toMatchObject({
      artifactProtocolVersion: 1,
      assets: {
        "assets/logo.png": {
          file: { url: expect.any(String) },
          fileHash: "logo-hash",
        },
      },
      manifestUrl: expect.any(String),
    });
  });

  it("fails closed when manifest storage cannot be read", async () => {
    const resolver = await setup(false);
    await expect(resolver(TARGET_ID, NIL_UUID, 1)).resolves.toBeNull();
  });
});
