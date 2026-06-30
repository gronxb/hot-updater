import type {
  AppUpdateAvailableInfo,
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import type {
  DatabaseBundleQueryOptions,
  DatabaseTelemetryCapabilities,
  DatabasePlugin,
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";

import type { PaginatedResult } from "../types";

export type DatabasePluginFactory<TContext = unknown> =
  (() => DatabasePlugin<TContext>) & Partial<DatabaseAdapterCapabilities>;

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

export type DatabaseAdapterWithCapabilities<TContext = unknown> =
  DatabasePlugin<TContext> & DatabaseAdapterCapabilities;

export type DatabaseAdapter<TContext = unknown> =
  | DatabaseAdapterWithCapabilities<TContext>
  | DatabasePlugin<TContext>
  | DatabasePluginFactory<TContext>;

export function isDatabasePluginFactory<TContext = unknown>(
  adapter: DatabaseAdapter<TContext>,
): adapter is DatabasePluginFactory<TContext> {
  return typeof adapter === "function";
}

export function isDatabasePlugin<TContext = unknown>(
  adapter: DatabaseAdapter<TContext>,
): adapter is DatabasePlugin<TContext> {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    "getBundleById" in adapter &&
    "getBundles" in adapter &&
    "getChannels" in adapter
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

export interface DatabaseAPI<
  TContext = unknown,
> extends DatabaseTelemetryCapabilities<TContext> {
  getBundleById(
    id: string,
    context?: HotUpdaterContext<TContext>,
  ): Promise<Bundle | null>;
  getUpdateInfo(
    args: GetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ): Promise<UpdateInfo | null>;
  getAppUpdateInfo(
    args: GetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ): Promise<AppUpdateAvailableInfo | null>;
  getChannels(context?: HotUpdaterContext<TContext>): Promise<string[]>;
  getBundles(
    options: DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TContext>,
  ): Promise<PaginatedResult>;
  insertBundle(
    bundle: Bundle,
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
