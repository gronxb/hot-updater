import {
  ARTIFACT_PROTOCOL_VERSION,
  getAssetBaseStorageUri,
  getBundlePatch,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
  type ArtifactInfo,
  type ArtifactAsset,
  type Bundle,
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

type PlannedAsset = {
  assetPath: string;
  file: PlannedFile;
  fileHash: string;
  patch: PlannedPatch | null;
};

type ManifestArtifactPlan = {
  assets: PlannedAsset[];
};

type ResolvedAssets = {
  assets: Record<string, ArtifactAsset>;
};

type ResolveFileUrl = (storageUri: string | null) => Promise<string | null>;

type ReadStorageText = (storageUri: string) => Promise<string | null>;

const HBC_ASSET_PATH_RE = /\.bundle$/;

const asByteSize = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

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
): Promise<BundleManifest | null> {
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

  return payload;
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
  currentBundle,
  targetBundle,
  targetManifest,
}: {
  assetBaseStorageUri: string;
  currentBundle: Bundle | null;
  targetBundle: Bundle;
  targetManifest: BundleManifest;
}): ManifestArtifactPlan {
  const patchCandidate = resolveHbcPatchPlan({
    currentBundle,
    targetBundle,
    targetManifest,
  });
  const assets = Object.entries(targetManifest.assets).map(
    ([assetPath, asset]): PlannedAsset => {
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

      return {
        assetPath,
        file,
        fileHash: asset.fileHash,
        patch,
      };
    },
  );
  return { assets };
}

async function resolveAssets(
  plan: ManifestArtifactPlan,
  resolveFileUrl: ResolveFileUrl,
): Promise<ResolvedAssets | null> {
  const patchAsset = plan.assets.find((asset) => asset.patch !== null);
  let resolvedPatch: {
    assetPath: string;
    patch: NonNullable<ArtifactAsset["patch"]>;
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

  const entries = await Promise.all(
    plan.assets.map(async (asset) => {
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

      if (!fileUrl) {
        return null;
      }

      const changedAsset: ArtifactAsset = {
        file: {
          url: fileUrl,
        },
        fileHash: asset.fileHash,
      };
      if (asset.file.compression) {
        changedAsset.file.compression = asset.file.compression;
      }
      if (patch) {
        changedAsset.patch = patch;
      }

      return {
        asset: [asset.assetPath, changedAsset] as const,
      };
    }),
  );

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  const resolvedEntries = entries.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  return {
    assets: Object.fromEntries(resolvedEntries.map((entry) => entry.asset)),
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
  ArtifactInfo,
  "artifactProtocolVersion" | "assets" | "manifestFileHash" | "manifestUrl"
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

  const targetManifest = await fetchBundleManifest(
    manifestStorageUri,
    readStorageText,
  );

  if (!targetManifest) {
    return null;
  }

  const plan = createManifestArtifactPlan({
    assetBaseStorageUri,
    currentBundle,
    targetBundle,
    targetManifest,
  });

  const manifestUrl = await resolveFileUrl(manifestStorageUri);
  if (!manifestUrl) {
    return null;
  }

  const resolved = await resolveAssets(plan, resolveFileUrl);
  if (!resolved) {
    return null;
  }

  return {
    artifactProtocolVersion: ARTIFACT_PROTOCOL_VERSION,
    assets: resolved.assets,
    manifestFileHash,
    manifestUrl,
  };
}
