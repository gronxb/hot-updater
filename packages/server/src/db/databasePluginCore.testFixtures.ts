import type { Bundle } from "@hot-updater/core";
import {
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";

export const currentBundle: Bundle = {
  id: "00000000-0000-0000-0000-000000000001",
  fileHash: "current-archive-hash",
  gitCommitHash: null,
  platform: "ios",
  storageUri:
    "r2://bucket/bundles/00000000-0000-0000-0000-000000000001/archive.zip",
  archiveByteSize: 3_000_000_001,
  manifestStorageUri:
    "r2://bucket/bundles/00000000-0000-0000-0000-000000000001/manifest.json",
  manifestFileHash: "sig:current-manifest",
  assetBaseStorageUri: "r2://bucket/assets",
};

export const targetBundle: Bundle = {
  ...currentBundle,
  id: "00000000-0000-0000-0000-000000000002",
  fileHash: "target-archive-hash",
  storageUri:
    "r2://bucket/bundles/00000000-0000-0000-0000-000000000002/archive.zip",
  manifestStorageUri:
    "r2://bucket/bundles/00000000-0000-0000-0000-000000000002/manifest.json",
  manifestFileHash: "sig:target-manifest",
  assetBaseStorageUri: "r2://bucket/assets",
  patches: [
    {
      baseBundleId: currentBundle.id,
      baseFileHash: "current-bundle-hash",
      patchFileHash: "patch-hash",
      patchStorageUri:
        "r2://bucket/bundles/00000000-0000-0000-0000-000000000002/patches/00000000-0000-0000-0000-000000000001/index.ios.bundle.bsdiff",
      byteSize: 3_000_000_002,
    },
  ],
};

export const resolveFileUrl = async (storageUri: string | null) => {
  if (!storageUri) return null;
  const url = new URL(storageUri);
  return `https://assets.example.com/${url.host}${url.pathname}`;
};

export const seedBundles = async (plugin: DatabasePlugin): Promise<void> => {
  const client = createDatabaseClient(plugin);
  await client.insertBundle(currentBundle);
  await client.insertBundle(targetBundle);
};

export const manifests = new Map<string, string>([
  [
    currentBundle.manifestStorageUri ?? "",
    JSON.stringify({
      bundleId: currentBundle.id,
      assets: {
        "index.ios.bundle": { fileHash: "current-bundle-hash" },
        "shared.png": { fileHash: "shared-hash" },
      },
    }),
  ],
  [
    targetBundle.manifestStorageUri ?? "",
    JSON.stringify({
      bundleId: targetBundle.id,
      assets: {
        "index.ios.bundle": { fileHash: "target-bundle-hash" },
        "shared.png": { fileHash: "shared-hash" },
      },
    }),
  ],
]);
