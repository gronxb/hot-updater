import type {
  AppUpdateAvailableInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import type {
  BundleEventAnalyticsResult,
  BundleEventAnalyticsWindow,
  BundleEventSummary,
  CreateBundleEventRequest,
  DatabaseAdapter as DatabaseAdapterContract,
  HotUpdaterContext,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";

export type {
  BundleEventAnalyticsResult,
  BundleEventAnalyticsWindow,
  BundleEventSummary,
  CreateBundleEventRequest,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
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
  DatabaseAdapterContract<TContext> & DatabaseAdapterCapabilities;

export type DatabaseAdapter<TContext = unknown> =
  DatabaseAdapterWithCapabilities<TContext>;

export function isDatabaseAdapter<TContext = unknown>(
  adapter: unknown,
): adapter is DatabaseAdapter<TContext> {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    "name" in adapter &&
    typeof adapter.name === "string" &&
    "create" in adapter &&
    typeof adapter.create === "function" &&
    "update" in adapter &&
    typeof adapter.update === "function" &&
    "delete" in adapter &&
    typeof adapter.delete === "function" &&
    "count" in adapter &&
    typeof adapter.count === "function" &&
    "findOne" in adapter &&
    typeof adapter.findOne === "function" &&
    "findMany" in adapter &&
    typeof adapter.findMany === "function"
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

export interface BundleEventAPI<TContext = unknown> {
  appendBundleEvent(
    input: CreateBundleEventRequest,
    context?: HotUpdaterContext<TContext>,
  ): Promise<void>;
  getBundleEventSummary(
    bundleId: string,
    context?: HotUpdaterContext<TContext>,
  ): Promise<BundleEventSummary>;
  getBundleEventAnalytics(
    bundleId: string,
    window: BundleEventAnalyticsWindow,
    limit: number,
    offset: number,
    context?: HotUpdaterContext<TContext>,
  ): Promise<BundleEventAnalyticsResult>;
  searchInstallations(
    query: string,
    limit: number,
    offset: number,
    context?: HotUpdaterContext<TContext>,
  ): Promise<OffsetPaginationResult<InstallationSearchRow>>;
  getInstallationHistory(
    installId: string,
    limit: number,
    offset: number,
    context?: HotUpdaterContext<TContext>,
  ): Promise<OffsetPaginationResult<InstallationHistoryRow>>;
}

export const supportsBundleEvents = <TContext>(
  api: object,
): api is BundleEventAPI<TContext> =>
  typeof Reflect.get(api, "appendBundleEvent") === "function" &&
  typeof Reflect.get(api, "getBundleEventSummary") === "function" &&
  typeof Reflect.get(api, "getBundleEventAnalytics") === "function" &&
  typeof Reflect.get(api, "searchInstallations") === "function" &&
  typeof Reflect.get(api, "getInstallationHistory") === "function";

export interface DatabaseAPI<TContext = unknown> extends Partial<
  BundleEventAPI<TContext>
> {
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
  getChannels(context?: HotUpdaterContext<TContext>): Promise<string[]>;
  getBundles(
    options: import("@hot-updater/plugin-core").DatabaseBundleQueryOptions,
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
