import type {
  Bundle,
  BundleMetadata,
  BundlePatchArtifact,
  BundlePatchArtifactMetadata,
} from "./types";

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
  "patches",
] as const;

type ArtifactMetadataKey = (typeof ARTIFACT_METADATA_KEYS)[number];

type LegacyArtifactMetadata = BundleMetadata &
  Partial<Record<ArtifactMetadataKey, unknown>>;

const isPatchMetadataEntry = (
  value: unknown,
): value is BundlePatchArtifactMetadata => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.base_file_hash === "string" &&
    typeof candidate.patch_file_hash === "string" &&
    typeof candidate.patch_storage_uri === "string"
  );
};

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

const createLegacyPatch = (
  bundle: Pick<
    Bundle,
    | "patchBaseBundleId"
    | "patchBaseFileHash"
    | "patchFileHash"
    | "patchStorageUri"
    | "metadata"
  >,
): BundlePatchArtifact | null => {
  const baseBundleId =
    bundle.patchBaseBundleId ??
    readString(bundle.metadata, "patch_base_bundle_id") ??
    readString(bundle.metadata, "diff_base_bundle_id");
  const baseFileHash =
    bundle.patchBaseFileHash ??
    readString(bundle.metadata, "hbc_patch_base_file_hash");
  const patchFileHash =
    bundle.patchFileHash ?? readString(bundle.metadata, "hbc_patch_file_hash");
  const patchStorageUri =
    bundle.patchStorageUri ??
    readString(bundle.metadata, "hbc_patch_storage_uri");

  if (!baseBundleId || !baseFileHash || !patchFileHash || !patchStorageUri) {
    return null;
  }

  return {
    baseBundleId,
    baseFileHash,
    patchFileHash,
    patchStorageUri,
  };
};

const isBundlePatchArtifact = (
  value: unknown,
): value is BundlePatchArtifact => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.baseBundleId === "string" &&
    typeof candidate.baseFileHash === "string" &&
    typeof candidate.patchFileHash === "string" &&
    typeof candidate.patchStorageUri === "string"
  );
};

const readBundlePatchArray = (
  patches: Bundle["patches"] | null | undefined,
): BundlePatchArtifact[] => {
  if (!Array.isArray(patches)) {
    return [];
  }

  return patches.filter(isBundlePatchArtifact);
};

const readPatchMetadataEntries = (
  metadata: LegacyArtifactMetadata | undefined,
): BundlePatchArtifact[] => {
  const value = metadata?.patches;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value)
    .filter((entry): entry is [string, BundlePatchArtifactMetadata] => {
      const [baseBundleId, patch] = entry;
      return Boolean(baseBundleId) && isPatchMetadataEntry(patch);
    })
    .map(([baseBundleId, patch]) => ({
      baseBundleId,
      baseFileHash: patch.base_file_hash,
      patchFileHash: patch.patch_file_hash,
      patchStorageUri: patch.patch_storage_uri,
    }));
};

export const getBundlePatches = (
  bundle: Pick<
    Bundle,
    | "patches"
    | "patchBaseBundleId"
    | "patchBaseFileHash"
    | "patchFileHash"
    | "patchStorageUri"
    | "metadata"
  >,
): BundlePatchArtifact[] => {
  const patches = [
    ...readBundlePatchArray(bundle.patches),
    createLegacyPatch(bundle),
    ...readPatchMetadataEntries(bundle.metadata),
  ].filter((patch): patch is BundlePatchArtifact => Boolean(patch));

  const seenBaseBundleIds = new Set<string>();

  return patches.filter((patch) => {
    if (seenBaseBundleIds.has(patch.baseBundleId)) {
      return false;
    }

    seenBaseBundleIds.add(patch.baseBundleId);
    return true;
  });
};

export const getBundlePatch = (
  bundle: Pick<
    Bundle,
    | "patches"
    | "patchBaseBundleId"
    | "patchBaseFileHash"
    | "patchFileHash"
    | "patchStorageUri"
    | "metadata"
  >,
  baseBundleId: string,
) => {
  return (
    getBundlePatches(bundle).find(
      (patch) => patch.baseBundleId === baseBundleId,
    ) ?? null
  );
};

const getPrimaryPatch = (
  bundle: Pick<
    Bundle,
    | "patches"
    | "patchBaseBundleId"
    | "patchBaseFileHash"
    | "patchFileHash"
    | "patchStorageUri"
    | "metadata"
  >,
) => {
  return getBundlePatches(bundle)[0] ?? null;
};

export const getPatchBaseBundleId = (
  bundle: Pick<
    Bundle,
    | "patches"
    | "patchBaseBundleId"
    | "patchBaseFileHash"
    | "patchFileHash"
    | "patchStorageUri"
    | "metadata"
  >,
) =>
  bundle.patchBaseBundleId ??
  getPrimaryPatch(bundle)?.baseBundleId ??
  readString(bundle.metadata, "patch_base_bundle_id") ??
  readString(bundle.metadata, "diff_base_bundle_id") ??
  null;

export const getPatchBaseFileHash = (
  bundle: Pick<
    Bundle,
    | "patches"
    | "patchBaseBundleId"
    | "patchBaseFileHash"
    | "patchFileHash"
    | "patchStorageUri"
    | "metadata"
  >,
) =>
  bundle.patchBaseFileHash ??
  getPrimaryPatch(bundle)?.baseFileHash ??
  readString(bundle.metadata, "hbc_patch_base_file_hash") ??
  null;

export const getPatchFileHash = (
  bundle: Pick<
    Bundle,
    | "patches"
    | "patchBaseBundleId"
    | "patchBaseFileHash"
    | "patchFileHash"
    | "patchStorageUri"
    | "metadata"
  >,
) =>
  bundle.patchFileHash ??
  getPrimaryPatch(bundle)?.patchFileHash ??
  readString(bundle.metadata, "hbc_patch_file_hash") ??
  null;

export const getPatchStorageUri = (
  bundle: Pick<
    Bundle,
    | "patches"
    | "patchBaseBundleId"
    | "patchBaseFileHash"
    | "patchFileHash"
    | "patchStorageUri"
    | "metadata"
  >,
) =>
  bundle.patchStorageUri ??
  getPrimaryPatch(bundle)?.patchStorageUri ??
  readString(bundle.metadata, "hbc_patch_storage_uri") ??
  null;
