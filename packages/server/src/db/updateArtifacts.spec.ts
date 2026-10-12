import {
  getSha256,
  createEngine,
  createMemoryAdapter,
} from "@hot-updater/plugin-core";
import { NIL_UUID, type Bundle } from "@hot-updater/protocol";
import { describe, expect, it, vi } from "vitest";

import { createCoreApi } from "../core/api";
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
  currentHash = "c".repeat(64),
  patchByteSize,
  targetHash = "d".repeat(64),
  targetDownloadByteSize = 10,
  resolveUrl,
  archive,
}: {
  currentHash?: string;
  patchByteSize?: number;
  targetHash?: string;
  targetDownloadByteSize?: number;
  resolveUrl?: (storageUri: string) => string | null;
  archive?: unknown;
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
              patchFileHash: "f".repeat(64),
              patchStorageUri: PATCH_URI,
            },
          ],
  });
  const manifests = new Map([
    [
      CURRENT_MANIFEST_URI,
      JSON.stringify({
        bundleId: CURRENT_ID,
        patchAssetPath: "index.ios.bundle",
        assets: {
          "index.ios.bundle": {
            fileHash: currentHash,
            downloadCompression: null,
          },
        },
      }),
    ],
    [
      TARGET_MANIFEST_URI,
      JSON.stringify({
        bundleId: TARGET_ID,
        patchAssetPath: "index.ios.bundle",
        ...(archive === undefined ? {} : { archive }),
        assets: {
          "index.ios.bundle": {
            downloadByteSize: targetDownloadByteSize,
            downloadCompression: "br",
            downloadFileHash: "a".repeat(64),
            fileHash: targetHash,
          },
        },
      }),
    ],
  ]);
  currentBundle.manifestFileHash = getSha256(
    manifests.get(CURRENT_MANIFEST_URI)!,
  );
  targetBundle.manifestFileHash = getSha256(
    manifests.get(TARGET_MANIFEST_URI)!,
  );
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
  const archive = {
    downloadFileHash: "d".repeat(64),
    downloadByteSize: 100,
    tarByteSize: 2048,
  };
  it("offers the canonical archive URL while preserving every original and patch cost", async () => {
    const { result } = await runScenario({ archive, patchByteSize: 3 });
    expect(result?.archiveUrl).toBe(
      `https://download.test/${encodeURIComponent(`s3://bucket/bundles/${TARGET_ID}/bundle.tar.br`)}`,
    );
    expect(result?.assets["index.ios.bundle"]?.file.url).toBeTruthy();
    expect(result?.assets["index.ios.bundle"]?.patch?.byteSize).toBe(3);
  });
  it("keeps originals when optional archive URL resolution fails", async () => {
    const { result } = await runScenario({
      archive,
      resolveUrl(uri) {
        if (uri.endsWith("bundle.tar.br")) throw new Error("unavailable");
        return `https://download.test/${encodeURIComponent(uri)}`;
      },
    });
    expect(result?.archiveUrl).toBeUndefined();
    expect(result?.assets["index.ios.bundle"]?.file.url).toBeTruthy();
  });
  it.each([
    { ...archive, downloadByteSize: -1 },
    { ...archive, tarByteSize: Number.MAX_SAFE_INTEGER + 1 },
    { ...archive, downloadFileHash: "not-a-hash" },
  ])("declines malformed optional archive metadata %o", async (archive) => {
    const { result, resolveFileUrl } = await runScenario({ archive });
    expect(result?.archiveUrl).toBeUndefined();
    expect(
      resolveFileUrl.mock.calls.some(([uri]) => uri?.endsWith("bundle.tar.br")),
    ).toBe(false);
  });
  it("returns an original descriptor for every target file, including unchanged files", async () => {
    const { result } = await runScenario({
      currentHash: "e".repeat(64),
      targetHash: "e".repeat(64),
    });

    expect(result).toMatchObject({
      artifactProtocolVersion: 1,
      assets: {
        "index.ios.bundle": {
          file: { compression: "br", url: expect.any(String) },
          fileHash: "e".repeat(64),
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

describe("core's artifact resolution", () => {
  const setup = async (readManifest = true) => {
    const manifestText = JSON.stringify({
      bundleId: TARGET_ID,
      assets: {
        "assets/logo.png": {
          downloadByteSize: 4,
          downloadCompression: null,
          fileHash: "b".repeat(64),
        },
      },
    });
    const core = createCoreApi(
      createEngine({ name: "memory", adapter: createMemoryAdapter() }).core,
      {
        ...(readManifest
          ? {
              readStorageText: async (uri: string) =>
                uri === TARGET_MANIFEST_URI ? manifestText : null,
            }
          : {}),
        resolveFileUrl: async (uri) =>
          uri ? `https://download.test/${encodeURIComponent(uri)}` : null,
      },
    );
    await core.deploy([
      {
        bundle: createBundle(TARGET_ID, {
          manifestFileHash: getSha256(manifestText),
        }),
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "*",
        },
      },
    ]);
    return core.getArtifactInfo;
  };

  it("serves the explicit manifest artifact protocol", async () => {
    const resolver = await setup();
    await expect(resolver(TARGET_ID, NIL_UUID, 1)).resolves.toMatchObject({
      artifactProtocolVersion: 1,
      assets: {
        "assets/logo.png": {
          file: { url: expect.any(String) },
          fileHash: "b".repeat(64),
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
