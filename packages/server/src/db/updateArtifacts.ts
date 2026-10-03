import {
  parseStoredBundleManifest,
  getBundleArchiveStorageUri,
  getManifestAssetDownloadPath,
  isContentAddressedAssetFileHash,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";
import {
  ARTIFACT_PROTOCOL_VERSION,
  MAX_UPDATE_ARTIFACT_RESPONSE_BYTES,
  getAssetBaseStorageUri,
  getBundlePatch,
  getManifestContentHash,
  getManifestFileHash,
  type BundleManifest,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
  type ArtifactInfo,
  type ArtifactAsset,
  type Bundle,
} from "@hot-updater/protocol";

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

const asByteSize = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

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
  bundle: Bundle,
  readStorageText: ReadStorageText,
): Promise<BundleManifest | null> {
  const text = await readStorageText(bundle.manifestStorageUri);
  if (text === null) return null;
  const manifest = parseStoredBundleManifest({
    bundleId: bundle.id,
    manifestBytes: new TextEncoder().encode(text),
    manifestContentHash: getManifestContentHash(bundle),
  });
  return manifest &&
    Object.values(manifest.assets).every(
      (asset) => asset.downloadCompression !== undefined,
    )
    ? manifest
    : null;
}

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

  if (
    !currentBundle ||
    !currentManifest ||
    currentBundle.platform !== targetBundle.platform ||
    !matchingPatch ||
    !patchAssetPath ||
    !Object.hasOwn(targetManifest.assets, patchAssetPath) ||
    !matchingPatch.patchStorageUri ||
    !isContentAddressedAssetFileHash(matchingPatch.patchFileHash) ||
    !isContentAddressedAssetFileHash(matchingPatch.baseFileHash) ||
    currentManifest.patchAssetPath !== patchAssetPath ||
    currentManifest.assets[patchAssetPath]?.fileHash !==
      matchingPatch.baseFileHash
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
  currentManifest,
  targetBundle,
  targetManifest,
}: {
  assetBaseStorageUri: string;
  currentBundle: Bundle | null;
  currentManifest: BundleManifest | null;
  targetBundle: Bundle;
  targetManifest: BundleManifest;
}): ManifestArtifactPlan {
  const patchCandidate = resolvePatchPlan({
    currentBundle,
    currentManifest,
    targetBundle,
    targetManifest,
  });
  const assets = Object.entries(targetManifest.assets).map(
    ([assetPath, asset]): PlannedAsset => {
      const downloadByteSize = asByteSize(asset.downloadByteSize);
      const downloadPath = getManifestAssetDownloadPath(
        assetPath,
        asset.downloadCompression!,
      );
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
    const patchUrl = await resolveFileUrl(patchAsset.patch.storageUri).catch(
      () => null,
    );
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

  const entries: ({ asset: readonly [string, ArtifactAsset] } | null)[] = [];
  for (let offset = 0; offset < plan.assets.length; offset += 16) {
    entries.push(
      ...(await Promise.all(
        plan.assets.slice(offset, offset + 16).map(async (asset) => {
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
      )),
    );
  }

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
    targetBundle,
    readStorageText,
  );

  if (!targetManifest) {
    return null;
  }

  const plan = createManifestArtifactPlan({
    assetBaseStorageUri,
    currentBundle,
    currentManifest:
      currentBundle && getBundlePatch(targetBundle, currentBundle.id)
        ? await fetchBundleManifest(currentBundle, readStorageText).catch(
            () => null,
          )
        : null,
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

  const artifact = {
    artifactProtocolVersion: ARTIFACT_PROTOCOL_VERSION,
    assets: resolved.assets,
    manifestFileHash,
    manifestUrl,
    ...(archiveUrl ? { archiveUrl } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(artifact)).byteLength <=
    MAX_UPDATE_ARTIFACT_RESPONSE_BYTES
    ? artifact
    : null;
}
