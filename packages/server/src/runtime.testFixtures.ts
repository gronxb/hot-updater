import type {
  EngineDatabase,
  StorageAdapter,
  StorageAdapterWith,
} from "@hot-updater/plugin-core";
import {
  createStorageAdapter,
  createEngineDatabase,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import {
  createMemoryAdapter,
  migrateSchema,
} from "@hot-updater/plugin-core/internal";
import type { SchemaSettings } from "@hot-updater/plugin-core/internal";
import type { Bundle } from "@hot-updater/protocol";

import { apiKeys } from "./plugins/api-keys";
import { insights } from "./plugins/insights";

export const runtimeBundle: Bundle = {
  id: "00000000-0000-0000-0000-000000000001",
  platform: "ios",
  gitCommitHash: null,
  manifestStorageUri: "s3://test-bucket/bundles/bundle/manifest.json",
  manifestFileHash: "manifest-hash",
  assetBaseStorageUri: "s3://test-bucket/assets",
};

export const createRuntimeStorage = (
  get: NonNullable<StorageAdapter["get"]> = async () => ({ response: null }),
  getDownloadUrl?: StorageAdapter["getDownloadUrl"],
): StorageAdapterWith<"get"> =>
  createStorageAdapter({
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

/** Every table the runtime specs use: core's, Insights', and API keys'. */
const runtimeTables = toolingTargetOf([insights(), apiKeys()]).schema.tables;

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
    await migrateSchema(adapter, name, runtimeTables, settings);
  }
  return createEngineDatabase({ name, adapter });
};
