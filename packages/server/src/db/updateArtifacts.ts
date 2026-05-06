import {
  getAssetBaseStorageUri,
  getBundlePatch,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
  type AppUpdateInfo,
  type Bundle,
  type ChangedAsset,
} from "@hot-updater/core";
import type { HotUpdaterContext } from "@hot-updater/plugin-core";

type BundleManifest = {
  bundleId: string;
  assets: Record<string, { fileHash: string; signature?: string }>;
};

type ResolveFileUrl<TContext> = (
  storageUri: string | null,
  context?: HotUpdaterContext<TContext>,
) => Promise<string | null>;

type ReadStorageText<TContext> = (
  storageUri: string,
  context?: HotUpdaterContext<TContext>,
) => Promise<string | null>;

const HBC_ASSET_PATH_RE = /\.bundle$/;

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

const createChildStorageUri = (
  baseStorageUri: string,
  relativePath: string,
) => {
  const baseUrl = new URL(baseStorageUri);
  const normalizedBasePath = baseUrl.pathname.replace(/\/+$/, "");
  const relativeSegments = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));

  baseUrl.pathname = `${normalizedBasePath}/${relativeSegments.join("/")}`;
  return baseUrl.toString();
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

async function fetchBundleManifest<TContext>(
  storageUri: string,
  readStorageText: ReadStorageText<TContext>,
  resolveFileUrl: ResolveFileUrl<TContext>,
  context?: HotUpdaterContext<TContext>,
): Promise<{ fileUrl: string; manifest: BundleManifest } | null> {
  const storageText = await readStorageText(storageUri, context);
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

  const fileUrl = await resolveFileUrl(storageUri, context);
  if (!fileUrl) {
    return null;
  }

  return {
    fileUrl,
    manifest: payload,
  };
}

async function resolveChangedAssets<TContext>({
  assetBaseStorageUri,
  currentManifest,
  resolveFileUrl,
  targetManifest,
  context,
}: {
  assetBaseStorageUri: string;
  currentManifest: BundleManifest | null;
  resolveFileUrl: ResolveFileUrl<TContext>;
  targetManifest: BundleManifest;
  context?: HotUpdaterContext<TContext>;
}): Promise<Record<string, ChangedAsset>> {
  const changedEntries = (
    await Promise.all(
      Object.entries(targetManifest.assets).map(async ([assetPath, asset]) => {
        const currentAsset = currentManifest?.assets[assetPath];
        if (currentAsset?.fileHash === asset.fileHash) {
          return null;
        }

        const storageUri = createChildStorageUri(
          assetBaseStorageUri,
          assetPath,
        );
        const fileUrl = await resolveFileUrl(storageUri, context);

        if (!fileUrl) {
          return null;
        }

        return [
          assetPath,
          {
            fileHash: asset.fileHash,
            fileUrl,
          },
        ] as const;
      }),
    )
  ).filter(
    (
      entry,
    ): entry is readonly [
      string,
      { readonly fileHash: string; readonly fileUrl: string },
    ] => entry !== null,
  );

  return Object.fromEntries(changedEntries);
}

const resolveHbcAssetPath = (manifest: BundleManifest) =>
  Object.keys(manifest.assets)
    .sort((left, right) => left.localeCompare(right))
    .find((candidate) => HBC_ASSET_PATH_RE.test(candidate)) ?? null;

async function attachHbcPatchDescriptor<TContext>({
  changedAssets,
  currentBundle,
  resolveFileUrl,
  targetBundle,
  targetManifest,
  context,
}: {
  changedAssets: Record<string, ChangedAsset>;
  currentBundle: Bundle | null;
  resolveFileUrl: ResolveFileUrl<TContext>;
  targetBundle: Bundle | null;
  targetManifest: BundleManifest;
  context?: HotUpdaterContext<TContext>;
}): Promise<Record<string, ChangedAsset>> {
  const matchingPatch =
    targetBundle && currentBundle
      ? getBundlePatch(targetBundle, currentBundle.id)
      : null;
  const patchAssetPath = resolveHbcAssetPath(targetManifest);

  if (
    !currentBundle ||
    !matchingPatch ||
    !patchAssetPath ||
    !matchingPatch.patchStorageUri ||
    !matchingPatch.patchFileHash ||
    !matchingPatch.baseFileHash
  ) {
    return changedAssets;
  }

  const changedAsset = changedAssets[patchAssetPath];
  if (!changedAsset) {
    return changedAssets;
  }

  const patchUrl = await resolveFileUrl(matchingPatch.patchStorageUri, context);
  if (!patchUrl) {
    return changedAssets;
  }

  return {
    ...changedAssets,
    [patchAssetPath]: {
      ...changedAsset,
      patch: {
        algorithm: "bsdiff",
        baseBundleId: matchingPatch.baseBundleId,
        baseFileHash: matchingPatch.baseFileHash,
        patchFileHash: matchingPatch.patchFileHash,
        patchUrl,
      },
    },
  };
}

export async function resolveManifestArtifacts<TContext>({
  currentBundle,
  resolveFileUrl,
  readStorageText,
  targetBundle,
  context,
}: {
  currentBundle: Bundle | null;
  resolveFileUrl: ResolveFileUrl<TContext>;
  readStorageText: ReadStorageText<TContext>;
  targetBundle: Bundle | null;
  context?: HotUpdaterContext<TContext>;
}): Promise<Pick<
  AppUpdateInfo,
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

  const targetManifestResult = await fetchBundleManifest(
    manifestStorageUri,
    readStorageText,
    resolveFileUrl,
    context,
  );

  if (!targetManifestResult) {
    return null;
  }

  const currentManifestStorageUri = currentBundle
    ? getManifestStorageUri(currentBundle)
    : null;
  const currentManifestResult = currentManifestStorageUri
    ? await fetchBundleManifest(
        currentManifestStorageUri,
        readStorageText,
        resolveFileUrl,
        context,
      )
    : null;

  const changedAssets = await resolveChangedAssets({
    assetBaseStorageUri,
    currentManifest: currentManifestResult?.manifest ?? null,
    resolveFileUrl,
    targetManifest: targetManifestResult.manifest,
    context,
  });
  const changedAssetsWithPatch = await attachHbcPatchDescriptor({
    changedAssets,
    currentBundle,
    resolveFileUrl,
    targetBundle,
    targetManifest: targetManifestResult.manifest,
    context,
  });

  return {
    changedAssets: changedAssetsWithPatch,
    manifestFileHash,
    manifestUrl: targetManifestResult.fileUrl,
  };
}
