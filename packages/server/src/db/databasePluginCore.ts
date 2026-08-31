import type { Bundle } from "@hot-updater/core";
import { decodeChannelKey } from "@hot-updater/core";
import {
  type ChannelRow,
  createDatabaseClient,
  deleteRelease as deleteReleasePolicy,
  preflightReleasePolicy as preflightReleasePolicyMutation,
  rebuildReleaseCatalog as rebuildReleaseCatalogProjection,
  updateReleasePolicy as updateReleasePolicyMutation,
} from "@hot-updater/plugin-core";

import {
  createArtifactResolver,
  createReleaseCatalogReader,
} from "./releaseCatalog";
import type { DatabaseAPI, DatabasePlugin } from "./types";

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
  const getReleaseCatalog = createReleaseCatalogReader(database);
  const getArtifact = createArtifactResolver({
    database,
    readStorageText: options?.readStorageText,
    resolveFileUrl,
  });
  const api: DatabaseAPI = {
    async getBundleById(id: string): Promise<Bundle | null> {
      await beforeOperation?.();
      return client.getBundleById(id);
    },

    async getReleaseCatalog(input) {
      await beforeOperation?.();
      return getReleaseCatalog(input);
    },

    async getArtifactInfo(targetBundleId, currentBundleId) {
      await beforeOperation?.();
      return getArtifact(targetBundleId, currentBundleId);
    },

    async getReleaseById(id) {
      await beforeOperation?.();
      return database.models.releases.findById(id);
    },

    async getReleasesByScope(input) {
      await beforeOperation?.();
      return database.models.releases.findManyByScope({
        ...input,
        consistency: "strong",
      });
    },

    async getReleases(input) {
      await beforeOperation?.();
      return database.models.releases.findMany(input);
    },

    async getReleaseCatalogByScopeKey(scopeKey) {
      await beforeOperation?.();
      return database.models.releaseCatalogs.findByScopeKey(scopeKey);
    },

    async getReleaseCatalogs(input) {
      await beforeOperation?.();
      return database.models.releaseCatalogs.findMany(input);
    },

    async updateReleasePolicy(input) {
      await beforeOperation?.();
      return updateReleasePolicyMutation({ database, ...input });
    },

    async preflightReleasePolicy(input) {
      await beforeOperation?.();
      return preflightReleasePolicyMutation({ database, ...input });
    },

    async deleteRelease(input) {
      await beforeOperation?.();
      return deleteReleasePolicy({ database, ...input });
    },

    async rebuildReleaseCatalog(scopeKey) {
      await beforeOperation?.();
      const catalog =
        await database.models.releaseCatalogs.findByScopeKey(scopeKey);
      if (catalog === null) {
        throw new Error(`Release catalog "${scopeKey}" was not found.`);
      }
      return rebuildReleaseCatalogProjection({
        database,
        scope: {
          channelId: catalog.channel_id,
          channelName: decodeChannelKey(catalog.channel_key),
          fingerprintHash: catalog.fingerprint_hash,
          platform: catalog.platform,
          scopeKey: catalog.scope_key,
          strategy: catalog.strategy,
        },
      });
    },

    async commitDatabase(input) {
      await beforeOperation?.();
      return database.commit(input);
    },

    async getChannels(): Promise<readonly ChannelRow[]> {
      await beforeOperation?.();
      return client.getChannels();
    },

    async insertChannel(input) {
      await beforeOperation?.();
      return database.models.channels.insert(input);
    },

    async deleteChannel(input) {
      await beforeOperation?.();
      return database.models.channels.delete(input);
    },

    async getBundles(options) {
      await beforeOperation?.();
      return client.getBundles(options);
    },

    async insertBundle(bundle: Bundle): Promise<void> {
      await beforeOperation?.();
      await client.insertBundle(bundle);
    },

    async insertBundles(bundles: readonly Bundle[]): Promise<void> {
      await beforeOperation?.();
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
