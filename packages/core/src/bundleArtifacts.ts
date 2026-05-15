import type { Bundle, BundleMetadata, BundlePatchArtifact } from "./types";

export const stripBundleArtifactMetadata = (
  metadata: BundleMetadata | undefined,
): BundleMetadata | undefined => metadata;

export const getManifestStorageUri = (
  bundle: Pick<Bundle, "manifestStorageUri" | "metadata">,
) => bundle.manifestStorageUri ?? null;

export const getManifestFileHash = (
  bundle: Pick<Bundle, "manifestFileHash" | "metadata">,
) => bundle.manifestFileHash ?? null;

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
) => bundle.patchBaseBundleId ?? getPrimaryPatch(bundle)?.baseBundleId ?? null;

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
) => bundle.patchBaseFileHash ?? getPrimaryPatch(bundle)?.baseFileHash ?? null;

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
) => bundle.patchFileHash ?? getPrimaryPatch(bundle)?.patchFileHash ?? null;

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
) => bundle.patchStorageUri ?? getPrimaryPatch(bundle)?.patchStorageUri ?? null;
