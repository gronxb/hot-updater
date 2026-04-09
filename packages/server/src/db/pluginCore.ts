import type {
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  ChangedAsset,
  FingerprintGetBundlesArgs,
  GetBundlesArgs,
  Platform,
  UpdateInfo,
} from "@hot-updater/core";
import { isCohortEligibleForUpdate, NIL_UUID } from "@hot-updater/core";
import {
  type DatabaseBundleQueryOptions,
  type DatabaseBundleQueryOrder,
  type DatabaseBundleQueryWhere,
  type DatabasePlugin,
  type HotUpdaterContext,
  semverSatisfies,
} from "@hot-updater/plugin-core";

import type { DatabaseAPI } from "./types";

const PAGE_SIZE = 100;
const DESC_ORDER = { field: "id", direction: "desc" } as const;

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

const bundleMatchesQueryWhere = (
  bundle: Bundle,
  where: DatabaseBundleQueryWhere | undefined,
) => {
  if (!where) return true;
  if (where.channel !== undefined && bundle.channel !== where.channel)
    return false;
  if (where.platform !== undefined && bundle.platform !== where.platform)
    return false;
  if (where.enabled !== undefined && bundle.enabled !== where.enabled)
    return false;
  if (where.id?.eq !== undefined && bundle.id !== where.id.eq) return false;
  if (where.id?.gt !== undefined && bundle.id.localeCompare(where.id.gt) <= 0)
    return false;
  if (where.id?.gte !== undefined && bundle.id.localeCompare(where.id.gte) < 0)
    return false;
  if (where.id?.lt !== undefined && bundle.id.localeCompare(where.id.lt) >= 0)
    return false;
  if (where.id?.lte !== undefined && bundle.id.localeCompare(where.id.lte) > 0)
    return false;
  if (where.id?.in && !where.id.in.includes(bundle.id)) return false;
  if (where.targetAppVersionNotNull && bundle.targetAppVersion === null) {
    return false;
  }
  if (
    where.targetAppVersion !== undefined &&
    bundle.targetAppVersion !== where.targetAppVersion
  ) {
    return false;
  }
  if (
    where.targetAppVersionIn &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  ) {
    return false;
  }
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }
  return true;
};

const sortBundles = (
  bundles: Bundle[],
  orderBy: DatabaseBundleQueryOrder | undefined,
) => {
  const direction = orderBy?.direction ?? "desc";
  return bundles.slice().sort((a, b) => {
    const result = a.id.localeCompare(b.id);
    return direction === "asc" ? result : -result;
  });
};

const makeResponse = (
  bundle: Bundle,
  status: "UPDATE" | "ROLLBACK",
): UpdateInfo => ({
  id: bundle.id,
  message: bundle.message,
  shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
  status,
  storageUri: bundle.storageUri,
  fileHash: bundle.fileHash,
});

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  message: null,
  id: NIL_UUID,
  shouldForceUpdate: true,
  status: "ROLLBACK",
  storageUri: null,
  fileHash: null,
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

export function createPluginDatabaseCore<TContext = unknown>(
  getPlugin: () => DatabasePlugin<TContext>,
  resolveFileUrl: (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string | null>,
  options?: {
    createMutationPlugin?: () => DatabasePlugin<TContext>;
    cleanupMutationPlugin?: (
      plugin: DatabasePlugin<TContext>,
    ) => Promise<void> | void;
  },
): {
  api: DatabaseAPI<TContext>;
  adapterName: string;
  createMigrator: () => never;
  generateSchema: () => never;
} {
  const runWithMutationPlugin = async <T>(
    operation: (plugin: DatabasePlugin<TContext>) => Promise<T>,
  ): Promise<T> => {
    const plugin = options?.createMutationPlugin?.() ?? getPlugin();

    try {
      return await operation(plugin);
    } finally {
      if (options?.createMutationPlugin) {
        await options.cleanupMutationPlugin?.(plugin);
      }
    }
  };

  const getSortedBundlePage = async (
    options: DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TContext>,
  ): Promise<Awaited<ReturnType<DatabasePlugin<TContext>["getBundles"]>>> => {
    const result = await getPlugin().getBundles(
      {
        ...options,
        orderBy: options.orderBy ?? DESC_ORDER,
      },
      context,
    );

    return {
      ...result,
      data: sortBundles(result.data, options.orderBy ?? DESC_ORDER),
    };
  };

  const isEligibleForUpdate = (
    bundle: Bundle,
    cohort: string | undefined,
  ): boolean => {
    return isCohortEligibleForUpdate(
      bundle.id,
      cohort,
      bundle.rolloutCohortCount,
      bundle.targetCohorts,
    );
  };

  const findUpdateInfoByScanning = async ({
    args,
    queryWhere,
    isCandidate,
    context,
  }: {
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs;
    queryWhere: DatabaseBundleQueryWhere;
    isCandidate: (bundle: Bundle) => boolean;
    context?: HotUpdaterContext<TContext>;
  }): Promise<UpdateInfo | null> => {
    let offset = 0;

    while (true) {
      const { data, pagination } = await getSortedBundlePage(
        {
          where: queryWhere,
          limit: PAGE_SIZE,
          offset,
          orderBy: DESC_ORDER,
        },
        context,
      );

      for (const bundle of data) {
        if (
          !bundleMatchesQueryWhere(bundle, queryWhere) ||
          !isCandidate(bundle)
        ) {
          continue;
        }

        if (args.bundleId === NIL_UUID) {
          if (isEligibleForUpdate(bundle, args.cohort)) {
            return makeResponse(bundle, "UPDATE");
          }
          continue;
        }

        const compareResult = bundle.id.localeCompare(args.bundleId);

        if (compareResult > 0) {
          if (isEligibleForUpdate(bundle, args.cohort)) {
            return makeResponse(bundle, "UPDATE");
          }
          continue;
        }

        if (compareResult === 0) {
          if (isEligibleForUpdate(bundle, args.cohort)) {
            return null;
          }
          continue;
        }

        return makeResponse(bundle, "ROLLBACK");
      }

      if (!pagination.hasNextPage) {
        break;
      }

      offset += PAGE_SIZE;
    }

    if (args.bundleId === NIL_UUID) {
      return null;
    }

    if (
      args.minBundleId &&
      args.bundleId.localeCompare(args.minBundleId) <= 0
    ) {
      return null;
    }

    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  };

  const getBaseWhere = ({
    platform,
    channel,
    minBundleId,
  }: {
    platform: Platform;
    channel: string;
    minBundleId: string;
  }): DatabaseBundleQueryWhere => ({
    platform,
    channel,
    enabled: true,
    id: {
      gte: minBundleId,
    },
  });

  const api: DatabaseAPI<TContext> = {
    async getBundleById(
      id: string,
      context?: HotUpdaterContext<TContext>,
    ): Promise<Bundle | null> {
      return getPlugin().getBundleById(id, context);
    },

    async getUpdateInfo(
      args: GetBundlesArgs,
      context?: HotUpdaterContext<TContext>,
    ): Promise<UpdateInfo | null> {
      const channel = args.channel ?? "production";
      const minBundleId = args.minBundleId ?? NIL_UUID;
      const baseWhere = getBaseWhere({
        platform: args.platform,
        channel,
        minBundleId,
      });

      if (args._updateStrategy === "fingerprint") {
        return findUpdateInfoByScanning({
          args,
          queryWhere: {
            ...baseWhere,
            fingerprintHash: args.fingerprintHash,
          },
          context,
          isCandidate: (bundle) => {
            return (
              bundle.enabled &&
              bundle.platform === args.platform &&
              bundle.channel === channel &&
              bundle.id.localeCompare(minBundleId) >= 0 &&
              bundle.fingerprintHash === args.fingerprintHash
            );
          },
        });
      }

      return findUpdateInfoByScanning({
        args,
        queryWhere: {
          ...baseWhere,
        },
        context,
        isCandidate: (bundle) => {
          return (
            bundle.enabled &&
            bundle.platform === args.platform &&
            bundle.channel === channel &&
            bundle.id.localeCompare(minBundleId) >= 0 &&
            !!bundle.targetAppVersion &&
            semverSatisfies(bundle.targetAppVersion, args.appVersion)
          );
        },
      });
    },

    async getAppUpdateInfo(
      args: GetBundlesArgs,
      context?: HotUpdaterContext<TContext>,
    ): Promise<AppUpdateInfo | null> {
      const info = await this.getUpdateInfo(args, context);
      if (!info) {
        return null;
      }
      const { storageUri, ...rest } = info as UpdateInfo & {
        storageUri: string | null;
      };
      const fileUrl = await resolveFileUrl(storageUri ?? null, context);
      const baseResponse: AppUpdateInfo = { ...rest, fileUrl };

      if (info.id === NIL_UUID) {
        return baseResponse;
      }

      const targetBundle = await getPlugin().getBundleById(info.id, context);
      const manifestStorageUri = targetBundle?.metadata?.manifest_storage_uri;
      const manifestFileHash = targetBundle?.metadata?.manifest_file_hash;
      const assetBaseStorageUri =
        targetBundle?.metadata?.asset_base_storage_uri;

      if (!manifestStorageUri || !manifestFileHash || !assetBaseStorageUri) {
        return baseResponse;
      }

      try {
        const currentBundle =
          args.bundleId !== NIL_UUID
            ? await getPlugin().getBundleById(args.bundleId, context)
            : null;
        const targetManifestResult = await fetchBundleManifest(
          manifestStorageUri,
          resolveFileUrl,
          context,
        );

        if (!targetManifestResult) {
          return baseResponse;
        }

        const currentManifestResult = currentBundle?.metadata
          ?.manifest_storage_uri
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
          ...baseResponse,
          changedAssets: changedAssetsWithPatch,
          manifestFileHash,
          manifestUrl: targetManifestResult.fileUrl,
        };
      } catch {
        return baseResponse;
      }
    },

    async getChannels(
      context?: HotUpdaterContext<TContext>,
    ): Promise<string[]> {
      return getPlugin().getChannels(context);
    },

    async getBundles(options, context?: HotUpdaterContext<TContext>) {
      return getPlugin().getBundles(options, context);
    },

    async insertBundle(
      bundle: Bundle,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await runWithMutationPlugin(async (plugin) => {
        await plugin.appendBundle(bundle, context);
        await plugin.commitBundle(context);
      });
    },

    async updateBundleById(
      bundleId: string,
      newBundle: Partial<Bundle>,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await runWithMutationPlugin(async (plugin) => {
        await plugin.updateBundle(bundleId, newBundle, context);
        await plugin.commitBundle(context);
      });
    },

    async deleteBundleById(
      bundleId: string,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await runWithMutationPlugin(async (plugin) => {
        const bundle = await plugin.getBundleById(bundleId, context);
        if (!bundle) {
          return;
        }
        await plugin.deleteBundle(bundle, context);
        await plugin.commitBundle(context);
      });
    },
  };

  return {
    api,
    adapterName: getPlugin().name,
    createMigrator: () => {
      throw new Error(
        "createMigrator is only available for Kysely/Prisma/Drizzle database adapters.",
      );
    },
    generateSchema: () => {
      throw new Error(
        "generateSchema is only available for Kysely/Prisma/Drizzle database adapters.",
      );
    },
  };
}
