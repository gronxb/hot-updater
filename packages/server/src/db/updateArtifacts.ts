import {
  getBundleArchiveStorageUri,
  getManifestAssetDownloadPath,
  isContentAddressedAssetFileHash,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";
import {
  ARTIFACT_FILES_PROTOCOL_VERSION,
  ARTIFACT_FILES_REQUEST_LIMIT,
  ARTIFACT_PROTOCOL_VERSION,
  getAssetBaseStorageUri,
  getBundlePatch,
  getManifestFileHash,
  getManifestStorageUri,
  type ArtifactAssetFile,
  type ArtifactFiles,
  type ArtifactInfo,
  type ArtifactInfoV2,
  type ArtifactAsset,
  type Bundle,
} from "@hot-updater/protocol";

type BundleManifestAsset = {
  downloadByteSize?: unknown;
  downloadFileHash?: unknown;
  fileHash: string;
  signature?: string;
};

type BundleManifest = {
  bundleId: string;
  assets: Record<string, BundleManifestAsset>;
  archive?: {
    downloadFileHash?: unknown;
    downloadByteSize?: unknown;
    tarByteSize?: unknown;
  };
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
          ...(patchAsset.patch.byteSize === null
            ? {}
            : { byteSize: patchAsset.patch.byteSize }),
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

/**
 * Legacy: artifact protocol v1. Signs a URL for every file of the target, which grows with the
 * Bundle's file count; apps whose SDK predates protocol v2 still ask for it.
 * Remove with the `/artifacts/v1` route once no supported app uses it.
 */
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
  | "artifactProtocolVersion"
  | "assets"
  | "manifestFileHash"
  | "manifestUrl"
  | "archiveUrl"
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

  let archiveUrl: string | null = null;
  const archive = targetManifest.archive;
  if (
    archive &&
    isContentAddressedAssetFileHash(archive.downloadFileHash) &&
    (asByteSize(archive.downloadByteSize) ?? 0) > 0 &&
    (asByteSize(archive.tarByteSize) ?? 0) > 0
  ) {
    try {
      archiveUrl = await resolveFileUrl(
        getBundleArchiveStorageUri({
          manifestStorageUri,
          bundleId: targetBundle.id,
        }),
      );
    } catch {
      // Bulk transport is optional; all original URLs remain available.
    }
  }

  return {
    artifactProtocolVersion: ARTIFACT_PROTOCOL_VERSION,
    assets: resolved.assets,
    manifestFileHash,
    manifestUrl,
    ...(archiveUrl ? { archiveUrl } : {}),
  };
}

/** The target's manifest and its plan, or null for a Bundle without one. */
async function loadTargetPlan({
  currentBundle,
  readStorageText,
  targetBundle,
}: {
  currentBundle: Bundle | null;
  readStorageText: ReadStorageText;
  targetBundle: Bundle;
}) {
  const manifestStorageUri = getManifestStorageUri(targetBundle);
  const manifestFileHash = getManifestFileHash(targetBundle);
  const assetBaseStorageUri = getAssetBaseStorageUri(targetBundle);
  if (!manifestStorageUri || !manifestFileHash || !assetBaseStorageUri) {
    return null;
  }
  const targetManifest = await fetchBundleManifest(
    manifestStorageUri,
    readStorageText,
  );
  if (!targetManifest) return null;
  return {
    manifestFileHash,
    manifestStorageUri,
    plan: createManifestArtifactPlan({
      assetBaseStorageUri,
      currentBundle,
      targetBundle,
      targetManifest,
    }),
    targetManifest,
  };
}

/**
 * Artifact protocol v2: the manifest, the archive, and the one Hermes patch,
 * but no URL per file. A device asks {@link resolveManifestArtifactFiles}
 * for the files it downloads one by one, so signing and the response stay
 * the same size however many files the Bundle has.
 */
export async function resolveManifestArtifactsV2({
  currentBundle,
  resolveFileUrl,
  readStorageText,
  targetBundle,
}: {
  currentBundle: Bundle | null;
  resolveFileUrl: ResolveFileUrl;
  readStorageText: ReadStorageText;
  targetBundle: Bundle;
}): Promise<ArtifactInfoV2 | null> {
  const target = await loadTargetPlan({
    currentBundle,
    readStorageText,
    targetBundle,
  });
  if (!target) return null;
  const manifestUrl = await resolveFileUrl(target.manifestStorageUri);
  if (!manifestUrl) return null;

  const patched = target.plan.assets.find((asset) => asset.patch !== null);
  let patch: ArtifactInfoV2["patch"];
  if (
    patched?.patch &&
    // A patch that costs as much as its file is no better than the file.
    !(
      patched.file.byteSize !== null &&
      patched.patch.byteSize !== null &&
      patched.patch.byteSize >= patched.file.byteSize
    )
  ) {
    try {
      const patchUrl = await resolveFileUrl(patched.patch.storageUri);
      if (patchUrl) {
        patch = {
          algorithm: "bsdiff",
          assetPath: patched.assetPath,
          baseBundleId: patched.patch.baseBundleId,
          baseFileHash: patched.patch.baseFileHash,
          patchFileHash: patched.patch.patchFileHash,
          patchUrl,
          ...(patched.patch.byteSize === null
            ? {}
            : { byteSize: patched.patch.byteSize }),
        };
      }
    } catch {
      // A patch is optional; the file stays available.
    }
  }

  let archiveUrl: string | null = null;
  const archive = target.targetManifest.archive;
  if (
    archive &&
    isContentAddressedAssetFileHash(archive.downloadFileHash) &&
    (asByteSize(archive.downloadByteSize) ?? 0) > 0 &&
    (asByteSize(archive.tarByteSize) ?? 0) > 0
  ) {
    try {
      archiveUrl = await resolveFileUrl(
        getBundleArchiveStorageUri({
          manifestStorageUri: target.manifestStorageUri,
          bundleId: targetBundle.id,
        }),
      );
    } catch {
      // Bulk transport is optional; every file stays available.
    }
  }

  return {
    artifactProtocolVersion: ARTIFACT_FILES_PROTOCOL_VERSION,
    manifestFileHash: target.manifestFileHash,
    manifestUrl,
    ...(archiveUrl ? { archiveUrl } : {}),
    ...(patch ? { patch } : {}),
  };
}

/**
 * Download URLs for the files a device downloads one by one. Only paths the
 * target's manifest names are signed, at most
 * {@link ARTIFACT_FILES_REQUEST_LIMIT}; null when any path is unknown or a
 * URL cannot be resolved.
 */
export async function resolveManifestArtifactFiles({
  paths,
  resolveFileUrl,
  readStorageText,
  targetBundle,
}: {
  paths: readonly string[];
  resolveFileUrl: ResolveFileUrl;
  readStorageText: ReadStorageText;
  targetBundle: Bundle;
}): Promise<ArtifactFiles | null> {
  if (
    paths.length === 0 ||
    paths.length > ARTIFACT_FILES_REQUEST_LIMIT ||
    new Set(paths).size !== paths.length
  ) {
    return null;
  }
  const target = await loadTargetPlan({
    currentBundle: null,
    readStorageText,
    targetBundle,
  });
  if (!target) return null;
  const planned = new Map(
    target.plan.assets.map((asset) => [asset.assetPath, asset]),
  );
  const requested = paths.map((path) => planned.get(path));
  if (requested.some((asset) => asset === undefined)) return null;

  const files = await Promise.all(
    requested.map(async (asset) => {
      const url = await resolveFileUrl(asset!.file.storageUri);
      if (!url) return null;
      const file: ArtifactAssetFile = { url };
      if (asset!.file.compression) file.compression = asset!.file.compression;
      return [asset!.assetPath, file] as const;
    }),
  );
  if (files.some((file) => file === null)) return null;
  return {
    files: Object.fromEntries(
      files.filter((file): file is NonNullable<typeof file> => file !== null),
    ),
  };
}
