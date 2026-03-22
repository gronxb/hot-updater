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

export function createPluginDatabaseCore(
  plugin: DatabasePlugin,
  resolveFileUrl: (storageUri: string | null) => Promise<string | null>,
): {
  api: DatabaseAPI;
  adapterName: string;
  createMigrator: () => never;
  generateSchema: () => never;
} {
  const getSortedBundlePage = async (
    options: DatabaseBundleQueryOptions,
  ): Promise<Awaited<ReturnType<DatabasePlugin["getBundles"]>>> => {
    const result = await plugin.getBundles({
      ...options,
      orderBy: options.orderBy ?? DESC_ORDER,
    });

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
  }: {
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs;
    queryWhere: DatabaseBundleQueryWhere;
    isCandidate: (bundle: Bundle) => boolean;
  }): Promise<UpdateInfo | null> => {
    let offset = 0;

    while (true) {
      const { data, pagination } = await getSortedBundlePage({
        where: queryWhere,
        limit: PAGE_SIZE,
        offset,
        orderBy: DESC_ORDER,
      });

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

  const api: DatabaseAPI = {
    async getBundleById(id: string): Promise<Bundle | null> {
      return plugin.getBundleById(id);
    },

    async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null> {
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
    ): Promise<AppUpdateInfo | null> {
      const info = await this.getUpdateInfo(args);
      if (!info) {
        return null;
      }
      const { storageUri, ...rest } = info as UpdateInfo & {
        storageUri: string | null;
      };
      const fileUrl = await resolveFileUrl(storageUri ?? null);
      return { ...rest, fileUrl };
    },

    async getChannels(): Promise<string[]> {
      return plugin.getChannels();
    },

    async getBundles(options) {
      return plugin.getBundles(options);
    },

    async insertBundle(bundle: Bundle): Promise<void> {
      await plugin.appendBundle(bundle);
      await plugin.commitBundle();
    },

    async updateBundleById(
      bundleId: string,
      newBundle: Partial<Bundle>,
    ): Promise<void> {
      await plugin.updateBundle(bundleId, newBundle);
      await plugin.commitBundle();
    },

    async deleteBundleById(bundleId: string): Promise<void> {
      const bundle = await plugin.getBundleById(bundleId);
      if (!bundle) {
        return;
      }
      await plugin.deleteBundle(bundle);
      await plugin.commitBundle();
    },
  };

  return {
    api,
    adapterName: plugin.name,
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
