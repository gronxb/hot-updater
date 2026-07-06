import type {
  AppUpdateAvailableInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  Platform,
  UpdateInfo,
} from "@hot-updater/core";
import { isCohortEligibleForUpdate, NIL_UUID } from "@hot-updater/core";
import type {
  DatabaseBundleEventInput,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
  DatabaseBundleRecord,
  DatabasePluginRuntime,
  HotUpdaterContext,
  MaybePromise,
} from "@hot-updater/plugin-core";
import {
  createRequestUpdateBundleResolver,
  listDatabaseRuntimeBundles,
  readDatabaseRuntimeBundle,
  semverSatisfies,
  stageDatabaseRuntimeBundleDelete,
  stageDatabaseRuntimeBundleInsert,
  stageDatabaseRuntimeBundleUpdate,
} from "@hot-updater/plugin-core";

import { assertBundlePersistenceConstraints } from "./schemaEnhancements";
import { type DatabaseAPI, UnsupportedBundleEventsError } from "./types";
import { resolveManifestArtifacts } from "./updateArtifacts";

const PAGE_SIZE = 100;
const DESC_ORDER = { field: "id", direction: "desc" } as const;

type RuntimeOpener<TContext> = (
  context?: HotUpdaterContext<TContext>,
) => MaybePromise<DatabasePluginRuntime>;

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

const listAllBundleRecords = async (
  runtime: DatabasePluginRuntime,
  where?: DatabaseBundleQueryWhere,
): Promise<DatabaseBundleRecord[]> => {
  const records: DatabaseBundleRecord[] = [];
  let after: string | undefined;

  while (true) {
    const page = await runtime.bundles.list({
      where,
      limit: PAGE_SIZE,
      orderBy: DESC_ORDER,
      ...(after ? { cursor: { after } } : {}),
    });
    records.push(...page.data);
    if (!page.pagination.hasNextPage) break;
    after = page.pagination.nextCursor ?? page.data.at(-1)?.id;
    if (!after) break;
  }

  return records;
};

export function createRuntimeDatabaseCore<TContext = unknown>(
  openRuntime: RuntimeOpener<TContext>,
  resolveFileUrl: (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string | null>,
  options?: {
    adapterName?: string;
    beforeOperation?: () => Promise<void>;
    readStorageText?: (
      storageUri: string,
      context?: HotUpdaterContext<TContext>,
    ) => Promise<string | null>;
  },
): {
  api: DatabaseAPI<TContext>;
  adapterName: string;
  createMigrator: () => never;
  generateSchema: () => never;
} {
  const requestRuntimes = new WeakMap<object, Promise<DatabasePluginRuntime>>();
  let defaultRuntime: Promise<DatabasePluginRuntime> | null = null;

  const getRuntime = (context?: HotUpdaterContext<TContext>) => {
    if (context && typeof context === "object") {
      const cached = requestRuntimes.get(context);
      if (cached) return cached;
      const runtime = Promise.resolve(openRuntime(context));
      requestRuntimes.set(context, runtime);
      return runtime;
    }

    defaultRuntime ??= Promise.resolve(openRuntime());
    return defaultRuntime;
  };

  const isEligibleForUpdate = (
    bundle: Bundle,
    cohort: string | undefined,
  ): boolean =>
    isCohortEligibleForUpdate(
      bundle.id,
      cohort,
      bundle.rolloutCohortCount,
      bundle.targetCohorts,
    );

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
    id: { gte: minBundleId },
  });

  const getSortedBundlePage = async (
    runtime: DatabasePluginRuntime,
    pageOptions: DatabaseBundleQueryOptions,
  ) => listDatabaseRuntimeBundles(runtime, pageOptions);

  const findUpdateInfoByScanning = async ({
    args,
    queryWhere,
    runtime,
    isCandidate,
  }: {
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs;
    queryWhere: DatabaseBundleQueryWhere;
    runtime: DatabasePluginRuntime;
    isCandidate: (bundle: Bundle) => boolean;
  }): Promise<UpdateInfo | null> => {
    let after: string | undefined;

    while (true) {
      const { data, pagination } = await getSortedBundlePage(runtime, {
        where: queryWhere,
        limit: PAGE_SIZE,
        orderBy: DESC_ORDER,
        ...(after ? { cursor: { after } } : {}),
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

      if (!pagination.hasNextPage) break;
      after = data.at(-1)?.id;
      if (!after) break;
    }

    if (args.bundleId === NIL_UUID) return null;
    if (
      args.minBundleId &&
      args.bundleId.localeCompare(args.minBundleId) <= 0
    ) {
      return null;
    }
    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  };

  const api: DatabaseAPI<TContext> = {
    async getBundleById(id, context) {
      await options?.beforeOperation?.();
      return readDatabaseRuntimeBundle(await getRuntime(context), id);
    },

    async getUpdateInfo(args, context) {
      await options?.beforeOperation?.();
      const runtime = await getRuntime(context);
      const directGetUpdateInfo = runtime.updateInfo?.get;
      if (directGetUpdateInfo) {
        return directGetUpdateInfo(args);
      }
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
          queryWhere: { ...baseWhere, fingerprintHash: args.fingerprintHash },
          runtime,
          isCandidate: (bundle) =>
            bundle.enabled &&
            bundle.platform === args.platform &&
            bundle.channel === channel &&
            bundle.id.localeCompare(minBundleId) >= 0 &&
            bundle.fingerprintHash === args.fingerprintHash,
        });
      }
      return findUpdateInfoByScanning({
        args,
        queryWhere: baseWhere,
        runtime,
        isCandidate: (bundle) =>
          bundle.enabled &&
          bundle.platform === args.platform &&
          bundle.channel === channel &&
          bundle.id.localeCompare(minBundleId) >= 0 &&
          !!bundle.targetAppVersion &&
          semverSatisfies(bundle.targetAppVersion, args.appVersion),
      });
    },

    async getAppUpdateInfo(args, context) {
      const info = await this.getUpdateInfo(args, context);
      if (!info) return null;
      const { storageUri, ...rest } = info;
      const readStorageText = options?.readStorageText;
      if (info.id === NIL_UUID || !readStorageText) {
        const fileUrl = await resolveFileUrl(storageUri ?? null, context);
        return { ...rest, fileUrl };
      }

      const runtime = await getRuntime(context);
      const requestBundles = createRequestUpdateBundleResolver(context);
      const getCurrentBundle = () => {
        if (args.bundleId === NIL_UUID) return null;
        const seededCurrentBundle = requestBundles.peek(args.bundleId);
        if (seededCurrentBundle || requestBundles.hasSeededBundles()) {
          return seededCurrentBundle;
        }
        return requestBundles.getById(args.bundleId, () =>
          readDatabaseRuntimeBundle(runtime, args.bundleId),
        );
      };
      const [fileUrl, targetBundle, currentBundle] = await Promise.all([
        resolveFileUrl(storageUri ?? null, context),
        requestBundles.getById(info.id, () =>
          readDatabaseRuntimeBundle(runtime, info.id),
        ),
        getCurrentBundle(),
      ]);
      const baseResponse: AppUpdateAvailableInfo = { ...rest, fileUrl };
      const manifestArtifacts = await resolveManifestArtifacts({
        currentBundle,
        resolveFileUrl,
        readStorageText,
        targetBundle,
        context,
      });
      return manifestArtifacts
        ? { ...baseResponse, ...manifestArtifacts }
        : baseResponse;
    },

    async getChannels(context) {
      await options?.beforeOperation?.();
      const records = await listAllBundleRecords(await getRuntime(context));
      return Array.from(
        new Set(records.map((bundle) => bundle.channel)),
      ).sort();
    },

    async getBundles(pageOptions, context) {
      await options?.beforeOperation?.();
      return listDatabaseRuntimeBundles(await getRuntime(context), pageOptions);
    },

    async insertBundle(bundle, context) {
      await options?.beforeOperation?.();
      const runtime = await openRuntime(context);
      await stageDatabaseRuntimeBundleInsert(runtime, {
        bundle,
        validate: assertBundlePersistenceConstraints,
      });
      await runtime.commit();
    },

    async updateBundleById(bundleId, newBundle, context) {
      await options?.beforeOperation?.();
      const runtime = await openRuntime(context);
      await stageDatabaseRuntimeBundleUpdate(runtime, {
        bundleId,
        patch: newBundle,
        validate: assertBundlePersistenceConstraints,
      });
      await runtime.commit();
    },

    async deleteBundleById(bundleId, context) {
      await options?.beforeOperation?.();
      const runtime = await openRuntime(context);
      const bundle = await readDatabaseRuntimeBundle(runtime, bundleId);
      if (!bundle) return;
      await stageDatabaseRuntimeBundleDelete(runtime, bundleId);
      await runtime.commit();
    },

    async appendBundleEvent(
      event: DatabaseBundleEventInput,
      context?: HotUpdaterContext<TContext>,
    ) {
      await options?.beforeOperation?.();
      const runtime = await openRuntime(context);
      if (!runtime.bundleEvents) {
        throw new UnsupportedBundleEventsError();
      }
      await runtime.bundleEvents.append({ event });
      await runtime.commit();
    },
  };

  return {
    api,
    adapterName: options?.adapterName ?? "database",
    createMigrator: () => {
      throw new Error(
        "createMigrator is only available for Kysely/MongoDB database adapters.",
      );
    },
    generateSchema: () => {
      throw new Error(
        "generateSchema is only available for Drizzle/Prisma database adapters.",
      );
    },
  };
}
