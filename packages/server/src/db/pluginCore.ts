import type {
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
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

export function createPluginDatabaseCore<TContext = unknown>(
  getPlugin: () => DatabasePlugin<TContext>,
  resolveFileUrl: (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string | null>,
  resetPlugin?: () => Promise<void> | void,
): {
  api: DatabaseAPI<TContext>;
  adapterName: string;
  createMigrator: () => never;
  generateSchema: () => never;
} {
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
      return { ...rest, fileUrl };
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
      const plugin = getPlugin();
      try {
        await plugin.appendBundle(bundle, context);
        await plugin.commitBundle(context);
      } catch (error) {
        await resetPlugin?.();
        throw error;
      }
    },

    async updateBundleById(
      bundleId: string,
      newBundle: Partial<Bundle>,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      const plugin = getPlugin();
      try {
        await plugin.updateBundle(bundleId, newBundle, context);
        await plugin.commitBundle(context);
      } catch (error) {
        await resetPlugin?.();
        throw error;
      }
    },

    async deleteBundleById(
      bundleId: string,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      const plugin = getPlugin();
      try {
        const bundle = await plugin.getBundleById(bundleId, context);
        if (!bundle) {
          return;
        }
        await plugin.deleteBundle(bundle, context);
        await plugin.commitBundle(context);
      } catch (error) {
        await resetPlugin?.();
        throw error;
      }
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
