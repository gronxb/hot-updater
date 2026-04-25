import type { Bundle, BundleMetadata } from "./types";

const ARTIFACT_METADATA_KEYS = [
  "manifest_storage_uri",
  "manifest_file_hash",
  "asset_base_storage_uri",
  "patch_base_bundle_id",
  "diff_base_bundle_id",
  "hbc_patch_algorithm",
  "hbc_patch_asset_path",
  "hbc_patch_base_file_hash",
  "hbc_patch_file_hash",
  "hbc_patch_storage_uri",
] as const;

type ArtifactMetadataKey = (typeof ARTIFACT_METADATA_KEYS)[number];

type LegacyArtifactMetadata = BundleMetadata &
  Partial<Record<ArtifactMetadataKey, unknown>>;

const readString = (
  metadata: LegacyArtifactMetadata | undefined,
  key: ArtifactMetadataKey,
) => {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const stripBundleArtifactMetadata = (
  metadata: BundleMetadata | undefined,
): BundleMetadata | undefined => {
  if (!metadata) {
    return undefined;
  }

  const nextMetadata = { ...metadata } as BundleMetadata &
    Partial<Record<ArtifactMetadataKey, unknown>>;

  for (const key of ARTIFACT_METADATA_KEYS) {
    delete nextMetadata[key];
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
};

export const getManifestStorageUri = (
  bundle: Pick<Bundle, "manifestStorageUri" | "metadata">,
) =>
  bundle.manifestStorageUri ??
  readString(bundle.metadata, "manifest_storage_uri") ??
  null;

export const getManifestFileHash = (
  bundle: Pick<Bundle, "manifestFileHash" | "metadata">,
) =>
  bundle.manifestFileHash ??
  readString(bundle.metadata, "manifest_file_hash") ??
  null;

export const getAssetBaseStorageUri = (
  bundle: Pick<Bundle, "assetBaseStorageUri" | "metadata">,
) =>
  bundle.assetBaseStorageUri ??
  readString(bundle.metadata, "asset_base_storage_uri") ??
  null;

export const getPatchBaseBundleId = (
  bundle: Pick<Bundle, "patchBaseBundleId" | "metadata">,
) =>
  bundle.patchBaseBundleId ??
  readString(bundle.metadata, "patch_base_bundle_id") ??
  readString(bundle.metadata, "diff_base_bundle_id") ??
  null;

export const getPatchBaseFileHash = (
  bundle: Pick<Bundle, "patchBaseFileHash" | "metadata">,
) =>
  bundle.patchBaseFileHash ??
  readString(bundle.metadata, "hbc_patch_base_file_hash") ??
  null;

export const getPatchFileHash = (
  bundle: Pick<Bundle, "patchFileHash" | "metadata">,
) =>
  bundle.patchFileHash ??
  readString(bundle.metadata, "hbc_patch_file_hash") ??
  null;

export const getPatchStorageUri = (
  bundle: Pick<Bundle, "patchStorageUri" | "metadata">,
) =>
  bundle.patchStorageUri ??
  readString(bundle.metadata, "hbc_patch_storage_uri") ??
  null;
