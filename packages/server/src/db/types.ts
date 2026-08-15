import type {
  AppUpdateAvailableInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import type {
  ChannelDeleteInput,
  ChannelDeleteResult,
  ChannelInsertInput,
  ChannelInsertResult,
  ChannelRow,
  DatabasePlugin as DatabasePluginContract,
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";

import type { PaginatedResult } from "../types";

export const sqlProviders = [
  "sqlite",
  "cockroachdb",
  "mysql",
  "postgresql",
  "mssql",
] as const;

export const noSqlProviders = ["mongodb"] as const;
export const providers = [...sqlProviders, ...noSqlProviders] as const;

export type ORMProvider = (typeof providers)[number];
export type ORMSQLProvider = (typeof sqlProviders)[number];
export type RelationMode = "foreign-keys" | "fumadb";

export interface MigrateOptions {
  mode?: "from-schema" | "from-database";
  updateSettings?: boolean;
  unsafe?: boolean;
}

export type MigrationOperation =
  | {
      type: "create-table";
      value: {
        ormName: string;
        columns: Record<string, { ormName: string; type: string }>;
      };
    }
  | { type: "custom"; description: string }
  | { type: "custom"; sql: string }
  | { type: "custom"; key: string; value: unknown };

export interface MigrationResult {
  operations: MigrationOperation[];
  execute: () => Promise<void>;
  getSQL?: () => string;
}

export interface Migrator {
  getVersion: () => Promise<string | undefined>;
  getNameVariants: () => Promise<unknown>;
  next: () => Promise<{ version: string } | undefined>;
  previous: () => Promise<{ version: string } | undefined>;
  up: (options?: MigrateOptions) => Promise<MigrationResult>;
  down: (options?: MigrateOptions) => Promise<MigrationResult>;
  migrateTo: (
    version: string,
    options?: MigrateOptions,
  ) => Promise<MigrationResult>;
  migrateToLatest: (options?: MigrateOptions) => Promise<MigrationResult>;
}

export type SchemaGenerator = (
  version: string | "latest",
  name?: string,
) => {
  code: string;
  path: string;
};

export interface DatabaseAdapterCapabilities {
  adapterName?: string;
  provider?: ORMProvider;
  createMigrator?: () => Migrator;
  generateSchema?: SchemaGenerator;
}

export type DatabaseAdapterWithCapabilities = DatabasePluginContract &
  DatabaseAdapterCapabilities;

export type DatabasePlugin = DatabaseAdapterWithCapabilities;

export function isDatabasePlugin(plugin: unknown): plugin is DatabasePlugin {
  return (
    typeof plugin === "object" &&
    plugin !== null &&
    "name" in plugin &&
    typeof plugin.name === "string" &&
    "models" in plugin &&
    typeof plugin.models === "object" &&
    plugin.models !== null &&
    "bundles" in plugin.models &&
    typeof plugin.models.bundles === "object" &&
    plugin.models.bundles !== null &&
    "findById" in plugin.models.bundles &&
    typeof plugin.models.bundles.findById === "function" &&
    "findMany" in plugin.models.bundles &&
    typeof plugin.models.bundles.findMany === "function" &&
    "count" in plugin.models.bundles &&
    typeof plugin.models.bundles.count === "function" &&
    "bundlePatches" in plugin.models &&
    typeof plugin.models.bundlePatches === "object" &&
    plugin.models.bundlePatches !== null &&
    "findByBundleIds" in plugin.models.bundlePatches &&
    typeof plugin.models.bundlePatches.findByBundleIds === "function" &&
    "channels" in plugin.models &&
    typeof plugin.models.channels === "object" &&
    plugin.models.channels !== null &&
    "insert" in plugin.models.channels &&
    typeof plugin.models.channels.insert === "function" &&
    "list" in plugin.models.channels &&
    typeof plugin.models.channels.list === "function" &&
    "delete" in plugin.models.channels &&
    typeof plugin.models.channels.delete === "function" &&
    "analytics" in plugin.models &&
    typeof plugin.models.analytics === "object" &&
    plugin.models.analytics !== null &&
    "append" in plugin.models.analytics &&
    typeof plugin.models.analytics.append === "function" &&
    "scan" in plugin.models.analytics &&
    typeof plugin.models.analytics.scan === "function" &&
    "clientAccessKeys" in plugin.models &&
    typeof plugin.models.clientAccessKeys === "object" &&
    plugin.models.clientAccessKeys !== null &&
    "create" in plugin.models.clientAccessKeys &&
    typeof plugin.models.clientAccessKeys.create === "function" &&
    "findByHash" in plugin.models.clientAccessKeys &&
    typeof plugin.models.clientAccessKeys.findByHash === "function" &&
    "list" in plugin.models.clientAccessKeys &&
    typeof plugin.models.clientAccessKeys.list === "function" &&
    "revoke" in plugin.models.clientAccessKeys &&
    typeof plugin.models.clientAccessKeys.revoke === "function" &&
    "queries" in plugin &&
    typeof plugin.queries === "object" &&
    plugin.queries !== null &&
    (!("getUpdateInfo" in plugin.queries) ||
      plugin.queries.getUpdateInfo === undefined ||
      typeof plugin.queries.getUpdateInfo === "function") &&
    "commit" in plugin &&
    typeof plugin.commit === "function" &&
    (!("dispose" in plugin) ||
      plugin.dispose === undefined ||
      typeof plugin.dispose === "function")
  );
}

export function getSQLProvider(
  provider: ORMProvider | undefined,
): ORMSQLProvider | undefined {
  if (!provider) {
    return undefined;
  }

  return (sqlProviders as readonly string[]).includes(provider)
    ? (provider as ORMSQLProvider)
    : undefined;
}

export interface DatabaseAPI<TContext = unknown> {
  getAppUpdateInfo: (
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<AppUpdateAvailableInfo | null>;
  getBundleById(
    id: string,
    context?: HotUpdaterContext<TContext>,
  ): Promise<Bundle | null>;
  getUpdateInfo(
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ): Promise<UpdateInfo | null>;
  getChannels(
    context?: HotUpdaterContext<TContext>,
  ): Promise<readonly ChannelRow[]>;
  insertChannel(
    input: ChannelInsertInput,
    context?: HotUpdaterContext<TContext>,
  ): Promise<ChannelInsertResult>;
  deleteChannel(
    input: ChannelDeleteInput,
    context?: HotUpdaterContext<TContext>,
  ): Promise<ChannelDeleteResult>;
  getBundles(
    options: import("@hot-updater/plugin-core").DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TContext>,
  ): Promise<PaginatedResult>;
  insertBundle(
    bundle: Bundle,
    context?: HotUpdaterContext<TContext>,
  ): Promise<void>;
  insertBundles(
    bundles: readonly Bundle[],
    context?: HotUpdaterContext<TContext>,
  ): Promise<void>;
  updateBundleById(
    bundleId: string,
    newBundle: Partial<Bundle>,
    context?: HotUpdaterContext<TContext>,
  ): Promise<void>;
  deleteBundleById(
    bundleId: string,
    context?: HotUpdaterContext<TContext>,
  ): Promise<void>;
}

export type StoragePluginFactory<TContext = unknown> =
  () => RuntimeStoragePlugin<TContext>;
