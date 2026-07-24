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
  type HotUpdaterContext,
} from "@hot-updater/plugin-core";

import { assertBundlePersistenceConstraints } from "./schemaEnhancements";
import type { DatabaseAPI, DatabasePlugin } from "./types";
import { resolveManifestArtifacts } from "./updateArtifacts";

export function createDatabasePluginCore<TContext = unknown>(
  database: DatabasePlugin,
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

  const api: DatabaseAPI<TContext> = {
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

    async insertBundles(
      bundles: readonly Bundle[],
      _context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await beforeOperation?.();
      for (const bundle of bundles) {
        assertBundlePersistenceConstraints(bundle);
      }
      if (bundles.length > 1 && database.transaction === undefined) {
        throw new Error(
          `Database plugin "${database.name}" does not support atomic bundle batches.`,
        );
      }
      await client.mutate(async (transaction) => {
        for (const bundle of bundles) {
          await transaction.insertBundle(bundle);
        }
      });
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
  };

  return {
    api,
    adapterName: database.name,
    createMigrator: () => {
      throw new Error(
        "createMigrator is only available for Kysely/MongoDB database plugins.",
      );
    },
    generateSchema: () => {
      throw new Error(
        "generateSchema is only available for Drizzle/Prisma database plugins.",
      );
    },
  };
}
