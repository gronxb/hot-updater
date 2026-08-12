import {
  getAssetBaseStorageUri,
  getBundlePatch,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
  type AppUpdateAvailableInfo,
  type Bundle,
  type ChangedAsset,
} from "@hot-updater/core";
import { resolveManifestAssetStorageUri } from "@hot-updater/plugin-core";

type BundleManifest = {
  bundleId: string;
  assets: Record<string, { fileHash: string; signature?: string }>;
};

type ResolveFileUrl = (storageUri: string | null) => Promise<string | null>;

type ReadStorageText = (storageUri: string) => Promise<string | null>;

const HBC_ASSET_PATH_RE = /\.bundle$/;
const BR_COMPRESSED_ASSET_PATH_RE = /(^|\/)index\.[^/]+\.bundle$/;

const resolveUniqueHbcAssetPath = (manifest: BundleManifest) => {
  const candidates = Object.keys(manifest.assets)
    .sort((left, right) => left.localeCompare(right))
    .filter((candidate) => HBC_ASSET_PATH_RE.test(candidate));

  return candidates.length === 1 ? candidates[0] : null;
};

const isBundleManifest = (value: unknown): value is BundleManifest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const manifest = value as {
    bundleId?: unknown;
    assets?: unknown;
  };

  if (typeof manifest.bundleId !== "string") {
    return false;
  }

  if (!manifest.assets || typeof manifest.assets !== "object") {
    return false;
  }

  return Object.values(manifest.assets as Record<string, unknown>).every(
    (asset) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
        return false;
      }

      const manifestAsset = asset as {
        fileHash?: unknown;
        signature?: unknown;
      };

      return (
        typeof manifestAsset.fileHash === "string" &&
        (manifestAsset.signature === undefined ||
          typeof manifestAsset.signature === "string")
      );
    },
  );
};

export const parseBundleMetadata = (
  value: unknown,
): Bundle["metadata"] | undefined => {
  if (!value) {
    return undefined;
  }

  let parsedValue: unknown = value;

  if (typeof parsedValue === "string") {
    try {
      parsedValue = JSON.parse(parsedValue) as unknown;
    } catch {
      return undefined;
    }
  }

  if (
    !parsedValue ||
    typeof parsedValue !== "object" ||
    Array.isArray(parsedValue)
  ) {
    return undefined;
  }

  return stripBundleArtifactMetadata(parsedValue as Bundle["metadata"]);
};

export const parseBundleRawMetadata = (
  value: unknown,
): Bundle["metadata"] | undefined => {
  if (!value) {
    return undefined;
  }

  let parsedValue: unknown = value;

  if (typeof parsedValue === "string") {
    try {
      parsedValue = JSON.parse(parsedValue) as unknown;
    } catch {
      return undefined;
    }
  }

  if (
    !parsedValue ||
    typeof parsedValue !== "object" ||
    Array.isArray(parsedValue)
  ) {
    return undefined;
  }

  return parsedValue as Bundle["metadata"];
};

async function fetchBundleManifest(
  storageUri: string,
  readStorageText: ReadStorageText,
  resolveFileUrl: ResolveFileUrl,
): Promise<{ fileUrl: string; manifest: BundleManifest } | null> {
  const [storageText, fileUrl] = await Promise.all([
    readStorageText(storageUri),
    resolveFileUrl(storageUri),
  ]);
  if (storageText === null) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(storageText) as unknown;
  } catch {
    return null;
  }

  if (!isBundleManifest(payload)) {
    return null;
  }

  if (!fileUrl) {
    return null;
  }

  return {
    fileUrl,
    manifest: payload,
  };
}

async function resolveChangedAssets({
  assetBaseStorageUri,
  currentManifest,
  currentBundle,
  resolveFileUrl,
  targetBundle,
  targetManifest,
}: {
  assetBaseStorageUri: string;
  currentManifest: BundleManifest | null;
  currentBundle: Bundle | null;
  resolveFileUrl: ResolveFileUrl;
  targetBundle: Bundle | null;
  targetManifest: BundleManifest;
}): Promise<Record<string, ChangedAsset> | null> {
  const patchDescriptor = await resolveHbcPatchDescriptor({
    currentBundle,
    resolveFileUrl,
    targetBundle,
    targetManifest,
  });
  const changedEntries = await Promise.all(
    Object.entries(targetManifest.assets).map(async ([assetPath, asset]) => {
      const currentAsset = currentManifest?.assets[assetPath];
      if (currentAsset?.fileHash === asset.fileHash) {
        return null;
      }

      const usesBrotliAsset = BR_COMPRESSED_ASSET_PATH_RE.test(assetPath);
      const downloadPath = usesBrotliAsset ? `${assetPath}.br` : assetPath;
      const storageUri = resolveManifestAssetStorageUri({
        assetBaseStorageUri,
        assetPath: downloadPath,
        fileHash: asset.fileHash,
      });
      const patch =
        patchDescriptor?.assetPath === assetPath ? patchDescriptor.patch : null;

      let fileUrl: string | null = null;
      try {
        fileUrl = await resolveFileUrl(storageUri);
      } catch (error) {
        if (!patch) {
          throw error;
        }
      }

      if (!fileUrl && !patch) {
        return false;
      }

      const changedAsset: ChangedAsset = {
        fileHash: asset.fileHash,
      };
      if (fileUrl) {
        changedAsset.file = {
          url: fileUrl,
        };
        if (usesBrotliAsset) {
          changedAsset.file.compression = "br";
        }
      }
      if (patch) {
        changedAsset.patch = patch;
      }

      return [assetPath, changedAsset] as const;
    }),
  );

  if (changedEntries.some((entry) => entry === false)) {
    return null;
  }

  return Object.fromEntries(
    changedEntries.filter(
      (entry): entry is readonly [string, ChangedAsset] => entry !== null,
    ),
  );
}

async function resolveHbcPatchDescriptor({
  currentBundle,
  resolveFileUrl,
  targetBundle,
  targetManifest,
}: {
  currentBundle: Bundle | null;
  resolveFileUrl: ResolveFileUrl;
  targetBundle: Bundle | null;
  targetManifest: BundleManifest;
}): Promise<{
  assetPath: string;
  patch: ChangedAsset["patch"];
} | null> {
  const matchingPatch =
    targetBundle && currentBundle
      ? getBundlePatch(targetBundle, currentBundle.id)
      : null;
  const patchAssetPath = resolveUniqueHbcAssetPath(targetManifest);

  if (
    !currentBundle ||
    !matchingPatch ||
    !patchAssetPath ||
    !matchingPatch.patchStorageUri ||
    !matchingPatch.patchFileHash ||
    !matchingPatch.baseFileHash
  ) {
    return null;
  }

  const patchUrl = await resolveFileUrl(matchingPatch.patchStorageUri);
  if (!patchUrl) {
    return null;
  }

  return {
    assetPath: patchAssetPath,
    patch: {
      algorithm: "bsdiff",
      baseBundleId: matchingPatch.baseBundleId,
      baseFileHash: matchingPatch.baseFileHash,
      patchFileHash: matchingPatch.patchFileHash,
      patchUrl,
    },
  };
}

export async function resolveManifestArtifacts({
  currentBundle,
  resolveFileUrl,
  readStorageText,
  targetBundle,
}: {
  currentBundle: Bundle | null;
  resolveFileUrl: ResolveFileUrl;
  readStorageText: ReadStorageText;
  targetBundle: Bundle | null;
}): Promise<Pick<
  AppUpdateAvailableInfo,
  "changedAssets" | "manifestFileHash" | "manifestUrl"
> | null> {
  const manifestStorageUri = targetBundle
    ? getManifestStorageUri(targetBundle)
    : null;
  const manifestFileHash = targetBundle
    ? getManifestFileHash(targetBundle)
    : null;
  const assetBaseStorageUri = targetBundle
    ? getAssetBaseStorageUri(targetBundle)
    : null;

  if (!manifestStorageUri || !manifestFileHash || !assetBaseStorageUri) {
    return null;
  }

  const currentManifestStorageUri = currentBundle
    ? getManifestStorageUri(currentBundle)
    : null;
  const [targetManifestResult, currentManifestResult] = await Promise.all([
    fetchBundleManifest(manifestStorageUri, readStorageText, resolveFileUrl),
    currentManifestStorageUri
      ? fetchBundleManifest(
          currentManifestStorageUri,
          readStorageText,
          resolveFileUrl,
        )
      : null,
  ]);

  if (!targetManifestResult) {
    return null;
  }

  const changedAssets = await resolveChangedAssets({
    assetBaseStorageUri,
    currentManifest: currentManifestResult?.manifest ?? null,
    currentBundle,
    resolveFileUrl,
    targetBundle,
    targetManifest: targetManifestResult.manifest,
  });
  if (!changedAssets) {
    return null;
  }

  return {
    changedAssets,
    manifestFileHash,
    manifestUrl: targetManifestResult.fileUrl,
  };
}
