import type {
  AppUpdateAvailableInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
} from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import {
  createDatabaseClient,
  createRequestBundleResolver,
  databaseBundleEventService,
  databaseAnalyticsSupport,
  type HotUpdaterContext,
} from "@hot-updater/plugin-core";

import {
  analyticsCapabilityMetadata,
  internalAnalyticsCapabilityProbe,
} from "./analyticsCapability";
import { createBundleEventService } from "./bundleEvents";
import { BUNDLE_EVENT_SCAN_MAX_ROWS } from "./bundleEventScan";
import { assertBundlePersistenceConstraints } from "./schemaEnhancements";
import type { DatabaseAPI, DatabaseAdapter } from "./types";
import { resolveManifestArtifacts } from "./updateArtifacts";

export function createDatabaseAdapterCore<TContext = unknown>(
  database: DatabaseAdapter,
  resolveFileUrl: (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string | null>,
  options?: {
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
  const client = createDatabaseClient(database);
  const beforeOperation = options?.beforeOperation;
  const dedicatedBundleEvents = database[databaseBundleEventService];
  const analyticsCapabilityProbe = Reflect.get(
    database,
    internalAnalyticsCapabilityProbe,
  );
  const bundleEvents =
    dedicatedBundleEvents ??
    (database[databaseAnalyticsSupport]
      ? createBundleEventService(database)
      : undefined);

  const api: DatabaseAPI<TContext> = {
    ...(bundleEvents
      ? {
          [analyticsCapabilityMetadata]: dedicatedBundleEvents
            ? { mode: "dedicated" as const }
            : {
                mode: "bounded" as const,
                maxMatchingRows: BUNDLE_EVENT_SCAN_MAX_ROWS,
              },
        }
      : {}),
    async getBundleById(
      id: string,
      _context?: HotUpdaterContext<TContext>,
    ): Promise<Bundle | null> {
      await beforeOperation?.();
      return client.getBundleById(id);
    },

    async getUpdateInfo(
      args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
      _context?: HotUpdaterContext<TContext>,
    ): Promise<import("@hot-updater/core").UpdateInfo | null> {
      await beforeOperation?.();
      return client.getUpdateInfo(args);
    },

    async getAppUpdateInfo(
      args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
      context?: HotUpdaterContext<TContext>,
    ): Promise<AppUpdateAvailableInfo | null> {
      const info = await this.getUpdateInfo(args, context);
      if (!info) return null;

      const { storageUri, ...rest } = info;
      const readStorageText = options?.readStorageText;
      if (info.id === NIL_UUID || !readStorageText) {
        return {
          ...rest,
          fileUrl: await resolveFileUrl(storageUri ?? null, context),
        };
      }

      const requestBundles = createRequestBundleResolver(context);
      const getBundleById = (id: string) =>
        requestBundles.getById(id, () => client.getBundleById(id));
      const getCurrentBundle = () =>
        args.bundleId === NIL_UUID ? null : getBundleById(args.bundleId);
      const [fileUrl, targetBundle, currentBundle] = await Promise.all([
        resolveFileUrl(storageUri ?? null, context),
        getBundleById(info.id),
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

    async getChannels(
      _context?: HotUpdaterContext<TContext>,
    ): Promise<string[]> {
      await beforeOperation?.();
      return client.getChannels();
    },

    async getBundles(options, _context?: HotUpdaterContext<TContext>) {
      await beforeOperation?.();
      return client.getBundles(options);
    },

    async insertBundle(
      bundle: Bundle,
      _context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await beforeOperation?.();
      assertBundlePersistenceConstraints(bundle);
      await client.insertBundle(bundle);
    },

    async updateBundleById(
      bundleId: string,
      update: Partial<Bundle>,
      _context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await beforeOperation?.();
      const current = await client.getBundleById(bundleId);
      if (!current) throw new Error("targetBundleId not found");
      const nextBundle: Bundle = {
        ...current,
        ...update,
        id: bundleId,
      };
      assertBundlePersistenceConstraints(nextBundle);
      await client.updateBundleById(bundleId, update);
    },

    async deleteBundleById(
      bundleId: string,
      _context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await beforeOperation?.();
      await client.deleteBundleById(bundleId);
    },

    ...(bundleEvents
      ? {
          async appendBundleEvent(input) {
            await beforeOperation?.();
            await bundleEvents.appendBundleEvent(input);
          },

          async getBundleEventSummary(bundleId) {
            await beforeOperation?.();
            return bundleEvents.getBundleEventSummary(bundleId);
          },

          async getBundleEventAnalytics(bundleId, window, limit, offset) {
            await beforeOperation?.();
            return bundleEvents.getBundleEventAnalytics(
              bundleId,
              window,
              limit,
              offset,
            );
          },

          async getBundleEventOverview() {
            await beforeOperation?.();
            return bundleEvents.getBundleEventOverview();
          },

          async getActiveInstallationOverview(input) {
            await beforeOperation?.();
            return bundleEvents.getActiveInstallationOverview(input);
          },

          async searchInstallations(query, limit, offset) {
            await beforeOperation?.();
            return bundleEvents.searchInstallations(query, limit, offset);
          },

          async getInstallationHistory(installId, limit, offset) {
            await beforeOperation?.();
            return bundleEvents.getInstallationHistory(
              installId,
              limit,
              offset,
            );
          },
        }
      : {}),
  };

  if (typeof analyticsCapabilityProbe === "function") {
    Object.assign(api, {
      [internalAnalyticsCapabilityProbe]: () =>
        Reflect.apply(analyticsCapabilityProbe, database, []),
    });
  }

  return {
    api,
    adapterName: database.name,
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
