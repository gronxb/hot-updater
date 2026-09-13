import type { Bundle, BundleMetadata, BundlePatchArtifact } from "./types";

export const MAX_UPDATE_ARTIFACT_RESPONSE_BYTES = 512 * 1024 + 4096;

export const stripBundleArtifactMetadata = (
  metadata: BundleMetadata | undefined,
): BundleMetadata | undefined => metadata;

export const getManifestStorageUri = (
  bundle: Pick<Bundle, "manifestStorageUri" | "metadata">,
) => bundle.manifestStorageUri ?? null;

export const getManifestFileHash = (
  bundle: Pick<Bundle, "manifestFileHash" | "metadata">,
) => bundle.manifestFileHash ?? null;

const SHA256_HASH = /^[0-9a-f]{64}$/;
const SIGNED_FILE_HASH =
  /^sig:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const isArtifactIntegrityToken = (value: unknown): value is string =>
  typeof value === "string" &&
  (SHA256_HASH.test(value) ||
    (value.length > 4 && SIGNED_FILE_HASH.test(value)));

/** Returns the raw SHA-256 used to verify downloaded manifest bytes. */
export const getManifestContentHash = (
  bundle: Pick<Bundle, "manifestFileHash" | "metadata">,
) => {
  const manifestFileHash = bundle.manifestFileHash;
  if (
    typeof manifestFileHash === "string" &&
    SHA256_HASH.test(manifestFileHash)
  ) {
    return manifestFileHash;
  }
  const metadataHash = bundle.metadata?.manifest_content_hash;
  if (
    typeof manifestFileHash === "string" &&
    manifestFileHash.length > 4 &&
    SIGNED_FILE_HASH.test(manifestFileHash) &&
    typeof metadataHash === "string" &&
    SHA256_HASH.test(metadataHash)
  ) {
    return metadataHash;
  }
  return null;
};

export const getAssetBaseStorageUri = (
  bundle: Pick<Bundle, "assetBaseStorageUri" | "metadata">,
) => bundle.assetBaseStorageUri ?? null;

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

export const getBundlePatches = (
  bundle: Pick<Bundle, "patches">,
): BundlePatchArtifact[] => {
  const patches = readBundlePatchArray(bundle.patches);

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
  bundle: Pick<Bundle, "patches">,
  baseBundleId: string,
) => {
  return (
    getBundlePatches(bundle).find(
      (patch) => patch.baseBundleId === baseBundleId,
    ) ?? null
  );
};

const getPrimaryPatch = (bundle: Pick<Bundle, "patches">) => {
  return getBundlePatches(bundle)[0] ?? null;
};

export const getPatchBaseBundleId = (bundle: Pick<Bundle, "patches">) =>
  getPrimaryPatch(bundle)?.baseBundleId ?? null;

export const getPatchBaseFileHash = (bundle: Pick<Bundle, "patches">) =>
  getPrimaryPatch(bundle)?.baseFileHash ?? null;

export const getPatchFileHash = (bundle: Pick<Bundle, "patches">) =>
  getPrimaryPatch(bundle)?.patchFileHash ?? null;

export const getPatchStorageUri = (bundle: Pick<Bundle, "patches">) =>
  getPrimaryPatch(bundle)?.patchStorageUri ?? null;
