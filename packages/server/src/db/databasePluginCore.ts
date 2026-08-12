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
} from "@hot-updater/plugin-core";

import { assertBundlePersistenceConstraints } from "./schemaEnhancements";
import type { DatabaseAPI, DatabasePlugin } from "./types";
import { resolveManifestArtifacts } from "./updateArtifacts";

export function createDatabasePluginCore(
  database: DatabasePlugin,
  resolveFileUrl: (storageUri: string | null) => Promise<string | null>,
  options?: {
    beforeOperation?: () => Promise<void>;
    readStorageText?: (storageUri: string) => Promise<string | null>;
  },
): {
  api: DatabaseAPI;
  adapterName: string;
  createMigrator: () => never;
  generateSchema: () => never;
} {
  const client = createDatabaseClient(database);
  const beforeOperation = options?.beforeOperation;
  const api: DatabaseAPI = {
    async getBundleById(id: string): Promise<Bundle | null> {
      await beforeOperation?.();
      return client.getBundleById(id);
    },

    async getUpdateInfo(
      args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
    ): Promise<import("@hot-updater/core").UpdateInfo | null> {
      await beforeOperation?.();
      return client.getUpdateInfo(args);
    },

    async getAppUpdateInfo(
      args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
    ): Promise<AppUpdateAvailableInfo | null> {
      const info = await this.getUpdateInfo(args);
      if (!info) return null;

      const { storageUri, ...rest } = info;
      const readStorageText = options?.readStorageText;
      if (info.id === NIL_UUID || !readStorageText) {
        return {
          ...rest,
          fileUrl: await resolveFileUrl(storageUri ?? null),
        };
      }

      const requestBundles = createRequestBundleResolver();
      const getBundleById = (id: string) =>
        requestBundles.getById(id, () => client.getBundleById(id));
      const getCurrentBundle = () =>
        args.bundleId === NIL_UUID ? null : getBundleById(args.bundleId);
      const [fileUrl, targetBundle, currentBundle] = await Promise.all([
        resolveFileUrl(storageUri ?? null),
        getBundleById(info.id),
        getCurrentBundle(),
      ]);
      const baseResponse: AppUpdateAvailableInfo = { ...rest, fileUrl };
      const manifestArtifacts = await resolveManifestArtifacts({
        currentBundle,
        resolveFileUrl,
        readStorageText,
        targetBundle,
      });
      return manifestArtifacts
        ? { ...baseResponse, ...manifestArtifacts }
        : baseResponse;
    },

    async getChannels(): Promise<string[]> {
      await beforeOperation?.();
      return client.getChannels();
    },

    async getBundles(options) {
      await beforeOperation?.();
      return client.getBundles(options);
    },

    async insertBundle(bundle: Bundle): Promise<void> {
      await beforeOperation?.();
      assertBundlePersistenceConstraints(bundle);
      await client.insertBundle(bundle);
    },

    async insertBundles(bundles: readonly Bundle[]): Promise<void> {
      await beforeOperation?.();
      for (const bundle of bundles) {
        assertBundlePersistenceConstraints(bundle);
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

    async deleteBundleById(bundleId: string): Promise<void> {
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
