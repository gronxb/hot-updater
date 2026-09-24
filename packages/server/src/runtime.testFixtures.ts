import type { Bundle } from "@hot-updater/core";
import type {
  EngineDatabase,
  StoragePlugin,
  StoragePluginWith,
} from "@hot-updater/plugin-core";
import { createStoragePlugin } from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";

import {
  builtInSchema,
  createEngineDatabase,
} from "./database/builtInDatabase";
import type { SchemaSettings } from "./database/fence";
import { migrateSchema } from "./db/schemaSettings";

export const runtimeBundle: Bundle = {
  id: "00000000-0000-0000-0000-000000000001",
  platform: "ios",
  gitCommitHash: null,
  manifestStorageUri: "s3://test-bucket/bundles/bundle/manifest.json",
  manifestFileHash: "manifest-hash",
  assetBaseStorageUri: "s3://test-bucket/assets",
};

export const createRuntimeStorage = (
  get: NonNullable<StoragePlugin["get"]> = async () => ({ response: null }),
  getDownloadUrl?: StoragePlugin["getDownloadUrl"],
): StoragePluginWith<"get"> =>
  createStoragePlugin({
    name: "testStorage",
    protocol: "s3",
    get,
    ...(getDownloadUrl ? { getDownloadUrl } : {}),
  });

/** An in-memory database on the storage engine, without the schema fence. */
export const createRuntimeDatabase = (
  name = "testDatabase",
): EngineDatabase => ({
  name,
  adapter: createMemoryAdapter(),
});

/**
 * An in-memory database behind the schema fence, as a provider builds it:
 * its tables and `settings` rows written first, or none at all.
 */
export const createFencedDatabase = async (
  name: string,
  settings?: SchemaSettings,
): Promise<EngineDatabase> => {
  const adapter = createMemoryAdapter();
  if (settings !== undefined) {
    await migrateSchema(adapter, name, builtInSchema.tables, settings);
  }
  return createEngineDatabase({ name, adapter });
};
