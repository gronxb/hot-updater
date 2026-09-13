import {
  getAssetBaseStorageUri,
  getBundlePatch,
  getManifestContentHash,
  getManifestFileHash,
  getManifestStorageUri,
  MAX_UPDATE_ARTIFACT_RESPONSE_BYTES,
  stripBundleArtifactMetadata,
  type ArtifactInfo,
  type Bundle,
  type BundleManifest,
  type ChangedAsset,
} from "@hot-updater/core";
import {
  getManifestAssetDownloadPath,
  isContentAddressedAssetFileHash,
  MAX_BUNDLE_ARCHIVE_BYTES,
  MAX_BUNDLE_ARTIFACT_BYTES,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";

import { parseStoredBundleManifest } from "./bundleManifestValidation";

type PlannedFile = {
  byteSize: number | null;
  compression: "br" | null;
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

const asBoundedByteSize = (value: unknown, maxBytes: number): number | null =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maxBytes
    ? value
    : null;

const asArtifactByteSize = (value: unknown): number | null =>
  asBoundedByteSize(value, MAX_BUNDLE_ARTIFACT_BYTES);

const asArchiveByteSize = (value: unknown): number | null =>
  asBoundedByteSize(value, MAX_BUNDLE_ARCHIVE_BYTES);

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

const getUtf8ByteSize = (value: string) =>
  new TextEncoder().encode(value).byteLength;

const exceedsMinimumManifestArtifactResponseSize = (
  changedAssets: readonly PlannedChangedAsset[],
  manifestFileHash: string,
) => {
  const minimumChangedAssets = Object.fromEntries(
    changedAssets.map((asset) => [
      asset.assetPath,
      {
        file: { compression: asset.file.compression, url: "" },
        fileHash: asset.fileHash,
        patch: null,
      },
    ]),
  );
  return (
    getUtf8ByteSize(
      JSON.stringify({
        changedAssets: minimumChangedAssets,
        manifestFileHash,
        manifestUrl: "",
      }),
    ) > MAX_UPDATE_ARTIFACT_RESPONSE_BYTES
  );
};

const shouldUseArchive = (
  targetBundle: Bundle,
  downloadByteSize: number | null,
) => {
  const archiveByteSize = asArchiveByteSize(targetBundle.archiveByteSize);
  return (
    archiveByteSize !== null &&
    downloadByteSize !== null &&
    downloadByteSize >= archiveByteSize
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
  bundleId: string,
  manifestContentHash: string | null,
  readStorageText: ReadStorageText,
): Promise<{
  byteSize: number | null;
  manifest: BundleManifest;
} | null> {
  const storageText = await readStorageText(storageUri);
  if (storageText === null) {
    return null;
  }

  const bytes = new TextEncoder().encode(storageText);
  const manifest = parseStoredBundleManifest({
    bundleId,
    manifestBytes: bytes,
    manifestContentHash,
  });
  if (!manifest) {
    return null;
  }

  return {
    byteSize: bytes.byteLength,
    manifest,
  };
}

const fetchBundleManifestOrNull = async (
  ...args: Parameters<typeof fetchBundleManifest>
) => {
  try {
    return await fetchBundleManifest(...args);
  } catch {
    return null;
  }
};

const hasExplicitDownloadRepresentation = (manifest: BundleManifest) =>
  Object.values(manifest.assets).every(
    (asset) => asset.downloadCompression !== undefined,
  );

function resolvePatchPlan({
  currentBundle,
  currentManifest,
  targetBundle,
  targetManifest,
}: {
  currentBundle: Bundle | null;
  currentManifest: BundleManifest | null;
  targetBundle: Bundle;
  targetManifest: BundleManifest;
}): { assetPath: string; patch: PlannedPatch } | null {
  const matchingPatch = currentBundle
    ? getBundlePatch(targetBundle, currentBundle.id)
    : null;
  const patchAssetPath = targetManifest.patchAssetPath;
  const currentPatchAsset = patchAssetPath
    ? currentManifest?.assets[patchAssetPath]
    : undefined;
  const patchByteSize = matchingPatch
    ? asArtifactByteSize(matchingPatch.byteSize)
    : null;

  if (
    !currentBundle ||
    currentBundle.platform !== targetBundle.platform ||
    !currentManifest ||
    !matchingPatch ||
    !patchAssetPath ||
    currentManifest.patchAssetPath !== patchAssetPath ||
    !targetManifest.assets[patchAssetPath] ||
    !currentPatchAsset ||
    !matchingPatch.patchStorageUri ||
    !isContentAddressedAssetFileHash(matchingPatch.patchFileHash) ||
    !isContentAddressedAssetFileHash(matchingPatch.baseFileHash) ||
    patchByteSize === null ||
    matchingPatch.baseFileHash !== currentPatchAsset.fileHash
  ) {
    return null;
  }

  return {
    assetPath: patchAssetPath,
    patch: {
      baseBundleId: matchingPatch.baseBundleId,
      baseFileHash: matchingPatch.baseFileHash,
      byteSize: patchByteSize,
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
  const reusableCurrentManifest =
    currentBundle?.platform === targetBundle.platform ? currentManifest : null;
  const patchCandidate = resolvePatchPlan({
    currentBundle,
    currentManifest: reusableCurrentManifest,
    targetBundle,
    targetManifest,
  });
  const changedAssets = Object.entries(targetManifest.assets).flatMap(
    ([assetPath, asset]): PlannedChangedAsset[] => {
      const currentAsset = reusableCurrentManifest?.assets[assetPath];
      if (currentAsset?.fileHash === asset.fileHash) {
        return [];
      }

      const downloadByteSize = asArtifactByteSize(asset.downloadByteSize);
      const downloadCompression = asset.downloadCompression;
      if (downloadCompression === undefined) {
        return [];
      }
      const downloadPath = getManifestAssetDownloadPath(
        assetPath,
        downloadCompression,
      );
      const hasValidDownloadFileHash = isContentAddressedAssetFileHash(
        asset.downloadFileHash,
      );
      const hasKnownDownloadByteSize =
        downloadByteSize !== null &&
        (hasValidDownloadFileHash ||
          (downloadCompression === null &&
            asset.downloadFileHash === undefined));
      const file: PlannedFile = {
        byteSize: hasKnownDownloadByteSize ? downloadByteSize : null,
        compression: downloadCompression,
        storageUri: resolveManifestAssetStorageUri({
          assetBaseStorageUri,
          assetPath: downloadPath,
          downloadFileHash: asset.downloadFileHash,
          fileHash: asset.fileHash,
        }),
      };
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
    let patchUrl: string | null = null;
    try {
      patchUrl = await resolveFileUrl(patchAsset.patch.storageUri);
    } catch {
      patchUrl = null;
    }
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

  const changedEntries: Array<{
    asset: readonly [string, ChangedAsset];
    primaryByteSize: number | null;
  } | null> = [];
  const concurrency = 16;
  for (
    let offset = 0;
    offset < plan.changedAssets.length;
    offset += concurrency
  ) {
    const batch = plan.changedAssets.slice(offset, offset + concurrency);
    changedEntries.push(
      ...(await Promise.all(
        batch.map(async (asset) => {
          let patch =
            resolvedPatch?.assetPath === asset.assetPath
              ? resolvedPatch.patch
              : null;
          let fileUrl: string | null = null;
          try {
            fileUrl = await resolveFileUrl(asset.file.storageUri);
          } catch {
            fileUrl = null;
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
            file: null,
            fileHash: asset.fileHash,
            patch: null,
          };
          if (fileUrl) {
            changedAsset.file = {
              compression: asset.file.compression,
              url: fileUrl,
            };
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
      )),
    );
  }

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
  const manifestContentHash = targetBundle
    ? getManifestContentHash(targetBundle)
    : null;
  const assetBaseStorageUri = targetBundle
    ? getAssetBaseStorageUri(targetBundle)
    : null;

  if (
    !targetBundle ||
    !manifestStorageUri ||
    !manifestFileHash ||
    !manifestContentHash ||
    !assetBaseStorageUri
  ) {
    return null;
  }

  const currentManifestStorageUri = currentBundle
    ? getManifestStorageUri(currentBundle)
    : null;
  const [targetManifestResult, currentManifestResult] = await Promise.all([
    fetchBundleManifestOrNull(
      manifestStorageUri,
      targetBundle.id,
      manifestContentHash,
      readStorageText,
    ),
    currentManifestStorageUri
      ? fetchBundleManifestOrNull(
          currentManifestStorageUri,
          currentBundle!.id,
          getManifestContentHash(currentBundle!),
          readStorageText,
        )
      : null,
  ]);

  if (
    !targetManifestResult ||
    !hasExplicitDownloadRepresentation(targetManifestResult.manifest)
  ) {
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

  if (
    exceedsMinimumManifestArtifactResponseSize(
      plan.changedAssets,
      manifestFileHash,
    )
  ) {
    return null;
  }

  let manifestUrl: string | null = null;
  try {
    manifestUrl = await resolveFileUrl(manifestStorageUri);
  } catch {
    manifestUrl = null;
  }
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
