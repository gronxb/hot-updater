import type {
  AppUpdateAvailableInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  LegacyBundle,
  UpdateInfo,
} from "@hot-updater/core";
import type {
  ChannelDeleteInput,
  ChannelDeleteResult,
  ChannelInsertInput,
  ChannelInsertResult,
  ChannelRow,
  DatabaseCommit,
  DatabaseCommitResult,
  DatabasePlugin as DatabasePluginContract,
  ReleaseCatalogMutationPreflight,
  ReleaseCatalogMutationResult,
  ReleaseCatalogRebuildResult,
  ReleaseCatalogRow,
  ReleasePolicyPatch,
  ReleaseRow,
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
  authorityId?: string;
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

export interface DatabaseAPI {
  getAppUpdateInfo: (
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
  ) => Promise<AppUpdateAvailableInfo | null>;
  getBundleById(id: string): Promise<Bundle | null>;
  getReleaseCatalog(
    input: import("./releaseCatalog").ReleaseCatalogRequest,
  ): Promise<import("@hot-updater/core").ReleaseCatalog | null>;
  getArtifactInfo(
    targetBundleId: string,
    currentBundleId: string,
  ): Promise<AppUpdateAvailableInfo | null>;
  getReleaseById(id: string): Promise<ReleaseRow | null>;
  getReleasesByScope(input: {
    readonly scopeKey: string;
    readonly afterReleaseId?: string;
    readonly limit: number;
  }): Promise<readonly ReleaseRow[]>;
  getReleases(input: {
    readonly afterReleaseId?: string;
    readonly beforeReleaseId?: string;
    readonly bundleId?: string;
    readonly channelId?: string;
    readonly enabled?: boolean;
    readonly platform?: "ios" | "android";
    readonly targetAppVersion?: string;
    readonly limit: number;
  }): Promise<readonly ReleaseRow[]>;
  getReleaseCatalogByScopeKey(
    scopeKey: string,
  ): Promise<ReleaseCatalogRow | null>;
  getReleaseCatalogs(input: {
    readonly afterScopeKey?: string;
    readonly limit: number;
  }): Promise<readonly ReleaseCatalogRow[]>;
  updateReleasePolicy(input: {
    readonly expectedRevision?: number;
    readonly patch: ReleasePolicyPatch;
    readonly releaseId: string;
  }): Promise<ReleaseCatalogMutationResult>;
  preflightReleasePolicy(input: {
    readonly expectedRevision?: number;
    readonly patch: ReleasePolicyPatch;
    readonly releaseId: string;
  }): Promise<ReleaseCatalogMutationPreflight>;
  deleteRelease(input: {
    readonly expectedRevision?: number;
    readonly releaseId: string;
  }): Promise<ReleaseCatalogMutationResult>;
  rebuildReleaseCatalog(scopeKey: string): Promise<ReleaseCatalogRebuildResult>;
  commitDatabase(input: DatabaseCommit): Promise<DatabaseCommitResult>;
  getUpdateInfo(
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
  ): Promise<UpdateInfo | null>;
  getChannels(): Promise<readonly ChannelRow[]>;
  insertChannel(input: ChannelInsertInput): Promise<ChannelInsertResult>;
  deleteChannel(input: ChannelDeleteInput): Promise<ChannelDeleteResult>;
  getBundles(
    options: import("@hot-updater/plugin-core").DatabaseBundleQueryOptions,
  ): Promise<PaginatedResult>;
  insertBundle(bundle: LegacyBundle): Promise<void>;
  insertBundles(bundles: readonly LegacyBundle[]): Promise<void>;
  updateBundleById(
    bundleId: string,
    newBundle: Partial<LegacyBundle>,
  ): Promise<void>;
  deleteBundleById(bundleId: string): Promise<void>;
}
