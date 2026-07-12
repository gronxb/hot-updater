import type {
  AppUpdateAvailableInfo,
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import {
  createDatabaseClient,
  createRequestBundleResolver,
  type DatabasePlugin,
  type HotUpdaterContext,
} from "@hot-updater/plugin-core";

import { assertBundlePersistenceConstraints } from "./schemaEnhancements";
import type { DatabaseAPI } from "./types";
import { resolveManifestArtifacts } from "./updateArtifacts";

export function createPluginDatabaseCore<TContext = unknown>(
  database: DatabasePlugin<TContext>,
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
      context?: HotUpdaterContext<TContext>,
    ): Promise<Bundle | null> {
      await beforeOperation?.();
      return client.getBundleById(id, context);
    },

    async getUpdateInfo(
      args: GetBundlesArgs,
      context?: HotUpdaterContext<TContext>,
    ): Promise<UpdateInfo | null> {
      await beforeOperation?.();
      return client.getUpdateInfo(args, context);
    },

    async getAppUpdateInfo(
      args: GetBundlesArgs,
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
        requestBundles.getById(id, () => client.getBundleById(id, context));
      const getCurrentBundle = () => {
        if (args.bundleId === NIL_UUID) return null;
        const seeded = requestBundles.peek(args.bundleId);
        if (seeded || requestBundles.hasSeededBundles()) return seeded;
        return getBundleById(args.bundleId);
      };
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
      context?: HotUpdaterContext<TContext>,
    ): Promise<string[]> {
      await beforeOperation?.();
      return client.getChannels(context);
    },

    async getBundles(options, context?: HotUpdaterContext<TContext>) {
      await beforeOperation?.();
      return client.getBundles(options, context);
    },

    async insertBundle(
      bundle: Bundle,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await beforeOperation?.();
      assertBundlePersistenceConstraints(bundle);
      await client.insertBundle(bundle, context);
    },

    async updateBundleById(
      bundleId: string,
      update: Partial<Bundle>,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await beforeOperation?.();
      const current = await client.getBundleById(bundleId, context);
      if (!current) throw new Error("targetBundleId not found");
      const nextBundle: Bundle = {
        ...current,
        ...update,
        id: bundleId,
      };
      assertBundlePersistenceConstraints(nextBundle);
      await client.updateBundleById(bundleId, update, context);
    },

    async deleteBundleById(
      bundleId: string,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await beforeOperation?.();
      await client.deleteBundleById(bundleId, context);
    },
  };

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
