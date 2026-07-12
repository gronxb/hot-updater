import type { Bundle } from "@hot-updater/core";
import type {
  DatabasePlugin,
  RequestEnvContext,
  RuntimeStoragePlugin,
  RuntimeStorageProfile,
} from "@hot-updater/plugin-core";

import { createInMemoryDatabaseAdapter } from "../../test-utils/test/inMemoryDatabaseAdapter";
import type { DatabaseAdapterCapabilities, Migrator } from "./db/types";

export const runtimeBundle: Bundle = {
  id: "00000000-0000-0000-0000-000000000001",
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "hash123",
  gitCommitHash: null,
  message: "Test bundle",
  channel: "production",
  storageUri: "s3://test-bucket/bundles/bundle.zip",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
};

export type TestContext = RequestEnvContext<{ assetHost: string }>;

export const createRuntimeStorage = (
  getDownloadUrl: RuntimeStorageProfile<TestContext>["getDownloadUrl"],
  readText: RuntimeStorageProfile<TestContext>["readText"] = async () => null,
): RuntimeStoragePlugin<TestContext> => ({
  name: "testStorage",
  supportedProtocol: "s3",
  profiles: { runtime: { getDownloadUrl, readText } },
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

export const createRuntimeDatabase = (): DatabasePlugin<TestContext> => ({
  ...createInMemoryDatabaseAdapter(),
  name: "testDatabase",
});

export const createSchemaManagedDatabase = (
  adapterName: string,
  version: string | undefined,
): DatabasePlugin<TestContext> & DatabaseAdapterCapabilities => ({
  ...createRuntimeDatabase(),
  adapterName,
  createMigrator: () => createMigrator(version),
});
