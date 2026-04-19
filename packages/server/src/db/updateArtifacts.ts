import type { AppUpdateInfo, Bundle, ChangedAsset } from "@hot-updater/core";
import type { HotUpdaterContext } from "@hot-updater/plugin-core";

type BundleManifest = {
  bundleId: string;
  assets: Record<string, { fileHash: string }>;
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
    (asset) =>
      !!asset &&
      typeof asset === "object" &&
      !Array.isArray(asset) &&
      typeof (asset as { fileHash?: unknown }).fileHash === "string",
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

  return parsedValue as Bundle["metadata"];
};

async function fetchBundleManifest<TContext>(
  storageUri: string,
  resolveFileUrl: (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string | null>,
  context?: HotUpdaterContext<TContext>,
): Promise<{ fileUrl: string; manifest: BundleManifest } | null> {
  const fileUrl = await resolveFileUrl(storageUri, context);

  if (!fileUrl) {
    return null;
  }

  const response = await fetch(fileUrl);
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as unknown;
  if (!isBundleManifest(payload)) {
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
  resolveFileUrl: (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string | null>;
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

async function attachHbcPatchDescriptor<TContext>({
  changedAssets,
  currentBundle,
  resolveFileUrl,
  targetBundle,
  context,
}: {
  changedAssets: Record<string, ChangedAsset>;
  currentBundle: Bundle | null;
  resolveFileUrl: (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string | null>;
  targetBundle: Bundle | null;
  context?: HotUpdaterContext<TContext>;
}): Promise<Record<string, ChangedAsset>> {
  const baseBundleId = targetBundle?.metadata?.diff_base_bundle_id;
  const patchAssetPath = targetBundle?.metadata?.hbc_patch_asset_path;
  const patchStorageUri = targetBundle?.metadata?.hbc_patch_storage_uri;
  const patchFileHash = targetBundle?.metadata?.hbc_patch_file_hash;
  const patchBaseFileHash = targetBundle?.metadata?.hbc_patch_base_file_hash;
  const patchAlgorithm =
    targetBundle?.metadata?.hbc_patch_algorithm ?? "bsdiff";

  if (
    currentBundle?.id !== baseBundleId ||
    !baseBundleId ||
    !patchAssetPath ||
    !patchStorageUri ||
    !patchFileHash ||
    !patchBaseFileHash ||
    patchAlgorithm !== "bsdiff"
  ) {
    return changedAssets;
  }

  const changedAsset = changedAssets[patchAssetPath];
  if (!changedAsset) {
    return changedAssets;
  }

  const patchUrl = await resolveFileUrl(patchStorageUri, context);
  if (!patchUrl) {
    return changedAssets;
  }

  return {
    ...changedAssets,
    [patchAssetPath]: {
      ...changedAsset,
      patch: {
        algorithm: "bsdiff",
        baseBundleId,
        baseFileHash: patchBaseFileHash,
        patchFileHash,
        patchUrl,
      },
    },
  };
}

export async function resolveManifestArtifacts<TContext>({
  currentBundle,
  resolveFileUrl,
  targetBundle,
  context,
}: {
  currentBundle: Bundle | null;
  resolveFileUrl: (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string | null>;
  targetBundle: Bundle | null;
  context?: HotUpdaterContext<TContext>;
}): Promise<Pick<
  AppUpdateInfo,
  "changedAssets" | "manifestFileHash" | "manifestUrl"
> | null> {
  const manifestStorageUri = targetBundle?.metadata?.manifest_storage_uri;
  const manifestFileHash = targetBundle?.metadata?.manifest_file_hash;
  const assetBaseStorageUri = targetBundle?.metadata?.asset_base_storage_uri;

  if (!manifestStorageUri || !manifestFileHash || !assetBaseStorageUri) {
    return null;
  }

  const targetManifestResult = await fetchBundleManifest(
    manifestStorageUri,
    resolveFileUrl,
    context,
  );

  if (!targetManifestResult) {
    return null;
  }

  const currentManifestResult = currentBundle?.metadata?.manifest_storage_uri
    ? await fetchBundleManifest(
        currentBundle.metadata.manifest_storage_uri,
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
    context,
  });

  return {
    changedAssets: changedAssetsWithPatch,
    manifestFileHash,
    manifestUrl: targetManifestResult.fileUrl,
  };
}
