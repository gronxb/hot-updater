import type {
  AppUpdateAvailableInfo,
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import type {
  DatabaseBundleQueryOptions,
  DatabaseBundleEventInput,
  DatabasePluginHandle,
  HotUpdaterContext,
  MaybePromise,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import type { DatabasePluginRuntime } from "@hot-updater/plugin-core/internal";
import type {
  CreateIndexesOptions,
  Document,
  IndexSpecification,
  OptionalUnlessRequiredId,
  Sort,
} from "mongodb";

import type { PaginatedResult } from "../types";

export type DatabaseRuntimeOpener<TContext = unknown> = ((
  context?: HotUpdaterContext<TContext>,
) => MaybePromise<DatabasePluginRuntime>) &
  Partial<DatabaseAdapterCapabilities>;

const databaseRuntimeFactorySymbol = Symbol.for(
  "@hot-updater/plugin-core/database-runtime-factory",
);

type DatabaseRuntimeWithFactory = DatabasePluginRuntime & {
  readonly [databaseRuntimeFactorySymbol]?: () => MaybePromise<DatabasePluginRuntime>;
};

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

export type DatabaseAdapterRuntime = DatabaseAdapterCapabilities &
  DatabasePluginRuntime &
  DatabasePluginHandle;

export interface MongoSessionRuntime {
  endSession(): MaybePromise<void>;
  withTransaction<TResult>(operation: () => Promise<TResult>): Promise<TResult>;
}

export interface MongoCursorRuntime<TRow extends Document> {
  sort(sort: Sort): MongoCursorRuntime<TRow>;
  project<TProjection extends Document>(
    projection: object,
  ): MongoCursorRuntime<TProjection>;
  toArray(): Promise<TRow[]>;
}

export interface MongoOperationOptions {
  readonly session?: MongoSessionRuntime;
  readonly upsert?: boolean;
}

export interface MongoCollectionRuntime<TRow extends Document> {
  findOne(
    filter: object,
    options?: MongoOperationOptions,
  ): Promise<TRow | null>;
  find(
    filter: object,
    options?: MongoOperationOptions,
  ): MongoCursorRuntime<TRow>;
  updateOne(
    filter: object,
    update: object,
    options?: MongoOperationOptions,
  ): Promise<unknown>;
  deleteMany(filter: object, options?: MongoOperationOptions): Promise<unknown>;
  insertMany(
    rows: readonly OptionalUnlessRequiredId<TRow>[],
    options?: MongoOperationOptions,
  ): Promise<unknown>;
  createIndex(
    index: IndexSpecification,
    options?: CreateIndexesOptions,
  ): Promise<unknown>;
}

export interface MongoDatabaseRuntime {
  collection<TRow extends Document = Document>(
    name: string,
  ): MongoCollectionRuntime<TRow>;
  createCollection(name: string): Promise<unknown>;
}

export interface MongoClientRuntime {
  db(): MongoDatabaseRuntime;
  startSession?(): MongoSessionRuntime;
}

export class UnsupportedBundleEventsError extends Error {
  constructor() {
    super("Bundle events are not supported by this database provider.");
    this.name = "UnsupportedBundleEventsError";
  }
}

export type MaybeDatabaseRuntime =
  | DatabasePluginRuntime
  | DatabasePluginHandle
  | PromiseLike<DatabasePluginRuntime | DatabasePluginHandle>;

export type DatabaseAdapter<TContext = unknown> =
  | MaybeDatabaseRuntime
  | DatabaseRuntimeOpener<TContext>;

export function isDatabaseRuntimeOpener<TContext = unknown>(
  adapter: DatabaseAdapter<TContext>,
): adapter is DatabaseRuntimeOpener<TContext> {
  return typeof adapter === "function";
}

export function isDatabasePluginRuntime<TContext = unknown>(
  adapter: DatabaseAdapter<TContext>,
): adapter is DatabasePluginRuntime {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    "bundles" in adapter &&
    "bundlePatches" in adapter &&
    "commit" in adapter
  );
}

export function openDatabaseRuntime(
  runtime: DatabasePluginRuntime | DatabasePluginHandle,
): MaybePromise<DatabasePluginRuntime> {
  const runtimeValue = runtime as DatabasePluginRuntime;
  const runtimeWithFactory = runtimeValue as DatabaseRuntimeWithFactory;
  const openRuntime = runtimeWithFactory[databaseRuntimeFactorySymbol];
  return openRuntime ? openRuntime() : runtimeValue;
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
  appendBundleEvent?(
    event: DatabaseBundleEventInput,
    context?: HotUpdaterContext<TContext>,
  ): Promise<void>;
}

export type StoragePluginFactory<TContext = unknown> =
  () => StoragePlugin<TContext>;
