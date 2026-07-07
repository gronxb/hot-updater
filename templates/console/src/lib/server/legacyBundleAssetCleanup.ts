import { createStorageUriWithRelativePath } from "@hot-updater/plugin-core";

interface BundleManifest {
  assets?: Record<string, { fileHash: string; signature?: string }>;
}

/**
 * LEGACY: older /files bundles own a per-bundle asset directory.
 * Remove this file and the deleteBundle branch that calls it when legacy
 * storage layouts are no longer supported.
 */
export function getLegacyBundleAssetCleanupUris({
  assetBaseStorageUri,
  manifest,
}: {
  assetBaseStorageUri: string;
  manifest: BundleManifest;
}) {
  return Object.keys(manifest.assets ?? {})
    .sort((a, b) => a.localeCompare(b))
    .map((assetPath) =>
      createStorageUriWithRelativePath({
        baseStorageUri: assetBaseStorageUri,
        relativePath: assetPath,
      }),
    );
}
