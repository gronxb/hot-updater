import {
  getAssetBaseStorageUri,
  getBundlePatch,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
  type ArtifactInfo,
  type Bundle,
  type ChangedAsset,
} from "@hot-updater/core";
import {
  getManifestAssetDownloadPath,
  isContentAddressedAssetFileHash,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";

type BundleManifestAsset = {
  downloadByteSize?: unknown;
  downloadFileHash?: unknown;
  fileHash: string;
  signature?: string;
};

type BundleManifest = {
  bundleId: string;
  assets: Record<string, BundleManifestAsset>;
};

type PlannedFile = {
  byteSize: number | null;
  compression?: "br";
  storageUri: string;
};

type PlannedPatch = {
  baseBundleId: string;
  baseFileHash: string;
  byteSize: number | null;
  patchFileHash: string;
  storageUri: string;
};

type PlannedChangedAsset = {
  assetPath: string;
  file: PlannedFile;
  fileHash: string;
  patch: PlannedPatch | null;
};

type ManifestArtifactPlan = {
  allPossibleByteSizesKnown: boolean;
  changedAssets: PlannedChangedAsset[];
  manifestByteSize: number | null;
  minimumDownloadByteSize: number | null;
};

type ResolvedChangedAssets = {
  changedAssets: Record<string, ChangedAsset>;
  primaryByteSizes: Array<number | null>;
};

type ResolveFileUrl = (storageUri: string | null) => Promise<string | null>;

type ReadStorageText = (storageUri: string) => Promise<string | null>;

const HBC_ASSET_PATH_RE = /\.bundle$/;

const asByteSize = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

const sumByteSizes = (byteSizes: Array<number | null>): number | null => {
  let total = 0;

  for (const byteSize of byteSizes) {
    if (byteSize === null || total > Number.MAX_SAFE_INTEGER - byteSize) {
      return null;
    }
    total += byteSize;
  }

  return total;
};

const shouldUseArchive = (
  targetBundle: Bundle,
  downloadByteSize: number | null,
) => {
  const archiveByteSize = asByteSize(targetBundle.archiveByteSize);
  return (
    archiveByteSize !== null &&
    downloadByteSize !== null &&
    downloadByteSize >= archiveByteSize
  );
};

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
): Promise<{
  byteSize: number | null;
  manifest: BundleManifest;
} | null> {
  const storageText = await readStorageText(storageUri);
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

  return {
    byteSize: asByteSize(new TextEncoder().encode(storageText).byteLength),
    manifest: payload,
  };
}

function resolveHbcPatchPlan({
  currentBundle,
  targetBundle,
  targetManifest,
}: {
  currentBundle: Bundle | null;
  targetBundle: Bundle;
  targetManifest: BundleManifest;
}): { assetPath: string; patch: PlannedPatch } | null {
  const matchingPatch = currentBundle
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

  return {
    assetPath: patchAssetPath,
    patch: {
      baseBundleId: matchingPatch.baseBundleId,
      baseFileHash: matchingPatch.baseFileHash,
      byteSize: asByteSize(matchingPatch.byteSize),
      patchFileHash: matchingPatch.patchFileHash,
      storageUri: matchingPatch.patchStorageUri,
    },
  };
}

function createManifestArtifactPlan({
  assetBaseStorageUri,
  currentManifest,
  currentBundle,
  targetBundle,
  targetManifest,
  targetManifestByteSize,
}: {
  assetBaseStorageUri: string;
  currentManifest: BundleManifest | null;
  currentBundle: Bundle | null;
  targetBundle: Bundle;
  targetManifest: BundleManifest;
  targetManifestByteSize: number | null;
}): ManifestArtifactPlan {
  const patchCandidate = resolveHbcPatchPlan({
    currentBundle,
    targetBundle,
    targetManifest,
  });
  const changedAssets = Object.entries(targetManifest.assets).flatMap(
    ([assetPath, asset]): PlannedChangedAsset[] => {
      const currentAsset = currentManifest?.assets[assetPath];
      if (currentAsset?.fileHash === asset.fileHash) {
        return [];
      }

      const downloadByteSize = asByteSize(asset.downloadByteSize);
      const downloadPath = getManifestAssetDownloadPath(assetPath);
      const isTransformedDownload = downloadPath !== assetPath;
      const hasValidDownloadFileHash = isContentAddressedAssetFileHash(
        asset.downloadFileHash,
      );
      const hasKnownDownloadByteSize =
        downloadByteSize !== null &&
        (hasValidDownloadFileHash ||
          (!isTransformedDownload && asset.downloadFileHash === undefined));
      const file: PlannedFile = {
        byteSize: hasKnownDownloadByteSize ? downloadByteSize : null,
        storageUri: resolveManifestAssetStorageUri({
          assetBaseStorageUri,
          assetPath: downloadPath,
          downloadFileHash: asset.downloadFileHash,
          fileHash: asset.fileHash,
        }),
      };
      if (isTransformedDownload) {
        file.compression = "br";
      }

      const patch =
        patchCandidate?.assetPath === assetPath ? patchCandidate.patch : null;

      return [
        {
          assetPath,
          file,
          fileHash: asset.fileHash,
          patch,
        },
      ];
    },
  );
  const allPossibleByteSizesKnown =
    targetManifestByteSize !== null &&
    changedAssets.every(
      (asset) =>
        asset.file.byteSize !== null &&
        (asset.patch === null || asset.patch.byteSize !== null),
    );
  const primaryByteSizes = changedAssets.map((asset) => {
    if (!asset.patch) return asset.file.byteSize;
    if (asset.patch.byteSize === null || asset.file.byteSize === null) {
      return null;
    }
    return Math.min(asset.patch.byteSize, asset.file.byteSize);
  });

  return {
    allPossibleByteSizesKnown,
    changedAssets,
    manifestByteSize: targetManifestByteSize,
    minimumDownloadByteSize: allPossibleByteSizesKnown
      ? sumByteSizes([targetManifestByteSize, ...primaryByteSizes])
      : null,
  };
}

async function resolveChangedAssets(
  plan: ManifestArtifactPlan,
  resolveFileUrl: ResolveFileUrl,
): Promise<ResolvedChangedAssets | null> {
  const patchAsset = plan.changedAssets.find((asset) => asset.patch !== null);
  let resolvedPatch: {
    assetPath: string;
    patch: NonNullable<ChangedAsset["patch"]>;
  } | null = null;

  if (patchAsset?.patch) {
    const patchUrl = await resolveFileUrl(patchAsset.patch.storageUri);
    if (patchUrl) {
      resolvedPatch = {
        assetPath: patchAsset.assetPath,
        patch: {
          algorithm: "bsdiff",
          baseBundleId: patchAsset.patch.baseBundleId,
          baseFileHash: patchAsset.patch.baseFileHash,
          patchFileHash: patchAsset.patch.patchFileHash,
          patchUrl,
        },
      };
    }
  }

  const changedEntries = await Promise.all(
    plan.changedAssets.map(async (asset) => {
      let patch =
        resolvedPatch?.assetPath === asset.assetPath
          ? resolvedPatch.patch
          : null;
      let fileUrl: string | null = null;
      try {
        fileUrl = await resolveFileUrl(asset.file.storageUri);
      } catch (error) {
        if (!patch) {
          throw error;
        }
      }

      if (
        fileUrl &&
        patch &&
        asset.file.byteSize !== null &&
        asset.patch !== null &&
        asset.patch.byteSize !== null &&
        asset.patch.byteSize >= asset.file.byteSize
      ) {
        patch = null;
      }

      if (!fileUrl && !patch) {
        return null;
      }

      const changedAsset: ChangedAsset = {
        fileHash: asset.fileHash,
      };
      if (fileUrl) {
        changedAsset.file = {
          url: fileUrl,
        };
        if (asset.file.compression) {
          changedAsset.file.compression = asset.file.compression;
        }
      }
      if (patch) {
        changedAsset.patch = patch;
      }

      return {
        asset: [asset.assetPath, changedAsset] as const,
        primaryByteSize: patch
          ? (asset.patch?.byteSize ?? null)
          : asset.file.byteSize,
      };
    }),
  );

  if (changedEntries.some((entry) => entry === null)) {
    return null;
  }

  const resolvedEntries = changedEntries.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  return {
    changedAssets: Object.fromEntries(
      resolvedEntries.map((entry) => entry.asset),
    ),
    primaryByteSizes: resolvedEntries.map((entry) => entry.primaryByteSize),
  };
}

export async function resolveManifestArtifacts({
  archiveUrlUsable,
  currentBundle,
  resolveFileUrl,
  readStorageText,
  targetBundle,
}: {
  archiveUrlUsable: boolean;
  currentBundle: Bundle | null;
  resolveFileUrl: ResolveFileUrl;
  readStorageText: ReadStorageText;
  targetBundle: Bundle | null;
}): Promise<Pick<
  ArtifactInfo,
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

  if (
    !targetBundle ||
    !manifestStorageUri ||
    !manifestFileHash ||
    !assetBaseStorageUri
  ) {
    return null;
  }

  const currentManifestStorageUri = currentBundle
    ? getManifestStorageUri(currentBundle)
    : null;
  const [targetManifestResult, currentManifestResult] = await Promise.all([
    fetchBundleManifest(manifestStorageUri, readStorageText),
    currentManifestStorageUri
      ? fetchBundleManifest(currentManifestStorageUri, readStorageText)
      : null,
  ]);

  if (!targetManifestResult) {
    return null;
  }

  const plan = createManifestArtifactPlan({
    assetBaseStorageUri,
    currentManifest: currentManifestResult?.manifest ?? null,
    currentBundle,
    targetBundle,
    targetManifest: targetManifestResult.manifest,
    targetManifestByteSize: targetManifestResult.byteSize,
  });

  if (
    archiveUrlUsable &&
    plan.allPossibleByteSizesKnown &&
    shouldUseArchive(targetBundle, plan.minimumDownloadByteSize)
  ) {
    return null;
  }

  const manifestUrl = await resolveFileUrl(manifestStorageUri);
  if (!manifestUrl) {
    return null;
  }

  const resolved = await resolveChangedAssets(plan, resolveFileUrl);
  if (!resolved) {
    return null;
  }

  const resolvedDownloadByteSize = sumByteSizes([
    plan.manifestByteSize,
    ...resolved.primaryByteSizes,
  ]);
  if (
    archiveUrlUsable &&
    shouldUseArchive(targetBundle, resolvedDownloadByteSize)
  ) {
    return null;
  }

  return {
    changedAssets: resolved.changedAssets,
    manifestFileHash,
    manifestUrl,
  };
}
