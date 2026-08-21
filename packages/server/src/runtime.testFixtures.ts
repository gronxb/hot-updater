import type { Bundle } from "@hot-updater/core";
import type {
  DatabasePlugin,
  StoragePlugin,
  StoragePluginWith,
} from "@hot-updater/plugin-core";
import { createStoragePlugin } from "@hot-updater/plugin-core";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import type { DatabaseAdapterCapabilities, Migrator } from "./db/types";

export const runtimeBundle: Bundle = {
  id: "00000000-0000-0000-0000-000000000001",
  platform: "ios",
  fileHash: "hash123",
  gitCommitHash: null,
  storageUri: "s3://test-bucket/bundles/bundle.zip",
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

const createMigrator = (version: string | undefined): Migrator => ({
  async getVersion() {
    return version;
  },
  async getNameVariants() {
    return {};
  },
  async next() {
    return undefined;
  },
  async previous() {
    return undefined;
  },
  async up() {
    throw new Error("not implemented");
  },
  async down() {
    throw new Error("not implemented");
  },
  async migrateTo() {
    throw new Error("not implemented");
  },
  async migrateToLatest() {
    throw new Error("not implemented");
  },
});

export const createRuntimeDatabase = (): DatabasePlugin => ({
  ...createInMemoryDatabasePlugin(),
  name: "testDatabase",
});

export const createSchemaManagedDatabase = (
  adapterName: string,
  version: string | undefined,
): DatabasePlugin & DatabaseAdapterCapabilities => ({
  ...createRuntimeDatabase(),
  adapterName,
  createMigrator: () => createMigrator(version),
});
