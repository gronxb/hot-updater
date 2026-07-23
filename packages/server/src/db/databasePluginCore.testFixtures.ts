import type { Bundle, GetBundlesArgs } from "@hot-updater/core";
import {
  createDatabaseClient,
  type DatabasePlugin,
  type RequestEnvContext,
} from "@hot-updater/plugin-core";

export const currentBundle: Bundle = {
  id: "00000000-0000-0000-0000-000000000001",
  channel: "production",
  enabled: true,
  fileHash: "current-archive-hash",
  fingerprintHash: null,
  gitCommitHash: null,
  message: "current",
  platform: "ios",
  shouldForceUpdate: false,
  storageUri: "r2://bucket/current/archive.zip",
  targetAppVersion: "1.0.0",
  manifestStorageUri: "r2://bucket/current/manifest.json",
  manifestFileHash: "sig:current-manifest",
  assetBaseStorageUri: "r2://bucket/current/files",
};

export const targetBundle: Bundle = {
  ...currentBundle,
  id: "00000000-0000-0000-0000-000000000002",
  fileHash: "target-archive-hash",
  message: "target",
  storageUri: "r2://bucket/target/archive.zip",
  manifestStorageUri: "r2://bucket/target/manifest.json",
  manifestFileHash: "sig:target-manifest",
  assetBaseStorageUri: "r2://bucket/target/files",
  patches: [
    {
      baseBundleId: currentBundle.id,
      baseFileHash: "current-bundle-hash",
      patchFileHash: "patch-hash",
      patchStorageUri: "r2://bucket/target/patch.bsdiff",
    },
  ],
};

export const updateArgs: GetBundlesArgs = {
  _updateStrategy: "appVersion",
  appVersion: "1.0.0",
  bundleId: currentBundle.id,
  platform: "ios",
};

export type TestContext = RequestEnvContext<{ assetHost: string }>;

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
