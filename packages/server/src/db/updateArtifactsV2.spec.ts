import {
  ARTIFACT_FILES_REQUEST_LIMIT,
  type Bundle,
} from "@hot-updater/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  resolveManifestArtifactFiles,
  resolveManifestArtifactsV2,
} from "./updateArtifacts";

const CURRENT_ID = "00000000-0000-0000-0000-000000000101";
const TARGET_ID = "00000000-0000-0000-0000-000000000102";
const TARGET_MANIFEST_URI = `s3://bucket/bundles/${TARGET_ID}/manifest.json`;
const PATCH_URI = `s3://bucket/bundles/${TARGET_ID}/patch.bsdiff`;
const ASSET_COUNT = 650;

const hash = (index: number) => index.toString(16).padStart(64, "0");

const createBundle = (id: string, overrides: Partial<Bundle> = {}): Bundle => ({
  id,
  platform: "android",
  gitCommitHash: null,
  manifestStorageUri: `s3://bucket/bundles/${id}/manifest.json`,
  manifestFileHash: `manifest-hash-${id}`,
  assetBaseStorageUri: "s3://bucket/assets",
  ...overrides,
});

const targetManifest = {
  bundleId: TARGET_ID,
  archive: {
    downloadFileHash: "d".repeat(64),
    downloadByteSize: 100,
    tarByteSize: 2048,
  },
  assets: {
    "index.android.bundle": {
      downloadByteSize: 10_000,
      downloadFileHash: "a".repeat(64),
      fileHash: "target-hash",
    },
    ...Object.fromEntries(
      Array.from({ length: ASSET_COUNT }, (_, index) => [
        `drawable-mdpi/icon${index}.png`,
        { downloadByteSize: 300, fileHash: hash(index) },
      ]),
    ),
  },
};

const setup = () => {
  const resolveFileUrl = vi.fn(async (storageUri: string | null) =>
    storageUri
      ? `https://download.test/${encodeURIComponent(storageUri)}`
      : null,
  );
  const readStorageText = vi.fn(async (uri: string) =>
    uri === TARGET_MANIFEST_URI ? JSON.stringify(targetManifest) : null,
  );
  const targetBundle = createBundle(TARGET_ID, {
    patches: [
      {
        baseBundleId: CURRENT_ID,
        baseFileHash: "current-hash",
        byteSize: 3,
        patchFileHash: "patch-hash",
        patchStorageUri: PATCH_URI,
      },
    ],
  });
  return { readStorageText, resolveFileUrl, targetBundle };
};

describe("resolveManifestArtifactsV2", () => {
  it("signs the manifest, the archive, and the patch, but no asset", async () => {
    const { readStorageText, resolveFileUrl, targetBundle } = setup();

    const info = await resolveManifestArtifactsV2({
      currentBundle: createBundle(CURRENT_ID),
      readStorageText,
      resolveFileUrl,
      targetBundle,
    });

    expect(resolveFileUrl).toHaveBeenCalledTimes(3);
    expect(info).toEqual({
      artifactProtocolVersion: 2,
      manifestUrl: `https://download.test/${encodeURIComponent(TARGET_MANIFEST_URI)}`,
      manifestFileHash: `manifest-hash-${TARGET_ID}`,
      archiveUrl: `https://download.test/${encodeURIComponent(`s3://bucket/bundles/${TARGET_ID}/bundle.tar.br`)}`,
      patch: {
        algorithm: "bsdiff",
        assetPath: "index.android.bundle",
        baseBundleId: CURRENT_ID,
        baseFileHash: "current-hash",
        byteSize: 3,
        patchFileHash: "patch-hash",
        patchUrl: `https://download.test/${encodeURIComponent(PATCH_URI)}`,
      },
    });
  });

  it("offers no patch that costs as much as the file", async () => {
    const { readStorageText, resolveFileUrl } = setup();
    const targetBundle = createBundle(TARGET_ID, {
      patches: [
        {
          baseBundleId: CURRENT_ID,
          baseFileHash: "current-hash",
          byteSize: 10_000,
          patchFileHash: "patch-hash",
          patchStorageUri: PATCH_URI,
        },
      ],
    });

    const info = await resolveManifestArtifactsV2({
      currentBundle: createBundle(CURRENT_ID),
      readStorageText,
      resolveFileUrl,
      targetBundle,
    });

    expect(info?.patch).toBeUndefined();
  });
});

describe("resolveManifestArtifactFiles", () => {
  it("signs only the requested files", async () => {
    const { readStorageText, resolveFileUrl, targetBundle } = setup();

    const files = await resolveManifestArtifactFiles({
      paths: ["index.android.bundle", "drawable-mdpi/icon7.png"],
      readStorageText,
      resolveFileUrl,
      targetBundle,
    });

    expect(resolveFileUrl).toHaveBeenCalledTimes(2);
    expect(files).toEqual({
      files: {
        "index.android.bundle": {
          compression: "br",
          url: `https://download.test/${encodeURIComponent(`s3://bucket/assets/sha256/aa/${"a".repeat(64)}.br`)}`,
        },
        "drawable-mdpi/icon7.png": {
          url: `https://download.test/${encodeURIComponent(`s3://bucket/assets/sha256/00/${hash(7)}.png`)}`,
        },
      },
    });
  });

  it("signs no key the manifest does not name", async () => {
    const { readStorageText, resolveFileUrl, targetBundle } = setup();

    await expect(
      resolveManifestArtifactFiles({
        paths: ["drawable-mdpi/icon7.png", "../../other-bundle/secret.png"],
        readStorageText,
        resolveFileUrl,
        targetBundle,
      }),
    ).resolves.toBeNull();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it(`resolves at most ${ARTIFACT_FILES_REQUEST_LIMIT} files at once`, async () => {
    const { readStorageText, resolveFileUrl, targetBundle } = setup();

    await expect(
      resolveManifestArtifactFiles({
        paths: Array.from(
          { length: ARTIFACT_FILES_REQUEST_LIMIT + 1 },
          (_, index) => `drawable-mdpi/icon${index}.png`,
        ),
        readStorageText,
        resolveFileUrl,
        targetBundle,
      }),
    ).resolves.toBeNull();
    expect(readStorageText).not.toHaveBeenCalled();
  });
});
