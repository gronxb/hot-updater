export * from "./bundleStorageLayout";
export * from "./assetStorageLayout";
export * from "./contentAddressedAssets";
export * from "./contentType";
export type {
  BundleDeployment,
  BundleDetail,
  Deployment,
  DeployReleasePolicy,
  HotUpdaterCoreApi,
  KeysetInput,
  ReleaseFilter,
  ReleaseTarget,
  StoredBundleDeployment,
} from "./coreApi";
export {
  DatabaseBundleNotFoundError,
  DatabaseAdapterInputError,
  DatabaseRowReferencedError,
  type DatabaseAdapterInputErrorCode,
} from "./databaseErrors";
export * from "./createStorageKeyBuilder";
export * from "./createStorageAdapter";
export { isDatabaseMetadataObject } from "./databaseJsonValue";
export * from "./databaseRows";
export * from "./filterCompatibleAppVersions";
export * from "./generateMinBundleId";
export * from "./parseStorageUri";
export * from "./releaseCatalogCompiler";
export * from "./releaseManagement";
export * from "./releaseCatalogMutation";
export * from "./remoteBundleSigning";
export * from "./semverSatisfies";
export * from "./storageDownloadPath";
export * from "./types";
export * from "./uuidv7";

// The server plugin authoring API: `definePlugin`, the schema DSL, the typed
// database handle, core's reads, and the errors a plugin handles.
// `@hot-updater/plugin-core` re-exports it for plugin authors; Hot
// Updater's own plugin packages import it here, below the server.
export {
  definePlugin,
  type AnyHotUpdaterPlugin,
  type CliFor,
  type ClientAuth,
  type CoreReader,
  type HotUpdaterPlugin,
  type InstanceFor,
  type PluginApis,
  type PluginCli,
  type PluginClientCredential,
  type PluginClientPlugin,
  type PluginCommand,
  type PluginCommandArgument,
  type PluginCommandContext,
  type PluginCommandOption,
  type PluginCommandUi,
  type PluginContext,
  type PluginEndpoint,
  type PluginEndpointMethod,
  type PluginInstance,
  type PluginProvides,
  type PluginTableColumn,
} from "./serverPlugin/definePlugin";
export {
  defineAggregate,
  defineTable,
  type AggregateDefinition,
  type CheckIndex,
  type DerivedDefinition,
  type DerivedFields,
  type FieldDefinition,
  type FieldReference,
  type FieldType,
  type FieldValue,
  type IndexDefinition,
  type ModelDefinition,
  type ModuleSchema,
  type ReferenceAction,
  type RetentionDefinition,
  type RowOf,
  type TableDefinition,
} from "./serverPlugin/schema";
export type {
  AggregateChanges,
  AggregateIdentity,
  AggregateRow,
  CreateRow,
  EngineColumns,
  FindAggregatesModel,
  FindManyModel,
  HotUpdaterDatabase,
  HotUpdaterTransaction,
  KeyLookup,
  Lookup,
  Page,
  ReadOptions,
  ReadRow,
  TableRow,
  UpdateSet,
} from "./serverPlugin/databaseHandle";
export type {
  CoreReads,
  ReleaseCatalogRequest,
} from "./serverPlugin/coreReads";
export {
  DatabaseAmbiguousCommitError,
  DatabaseConflictError,
  DatabaseConstraintError,
  DatabaseCursorError,
  DatabaseQueryError,
  DatabaseTransactionError,
  type ConstraintReason,
} from "./serverPlugin/errors";
export { isDatabaseBusyError } from "./serverPlugin/busy";
// The sketches of a `distinct` aggregate metric.
export { addDistinct, countDistinct, mergeDistinct } from "./database/distinct";
export { HotUpdaterConfigError } from "./serverPlugin/configError";

// The database adapter kit: the adapter contract, the SQL and key-value
// adapters, the storage engine's database, and core's schema.
export {
  type DatabaseAdapter,
  type DatabaseJson,
  type DatabaseKey,
  type DatabaseKeyValue,
  DatabaseSchemaError,
  type DatabaseValue,
  type PhysicalColumn,
  type PhysicalColumnType,
  type PhysicalIndex,
  type PhysicalRetention,
  type PhysicalTable,
  type QueryBound,
  type QueryRequest,
  type StoredRow,
  type WriteGuard,
  type WriteOp,
  type WriteResult,
  expiresAt,
  indexOrderColumns,
} from "./database/adapter";
export { createMemoryAdapter } from "./database/memoryAdapter";
export { normalizeStoredRow } from "./database/values";
export { verifyAdapter } from "./database/verifyAdapter";
export { HotUpdaterSchemaMigrationRequiredError } from "./engine/database/fence";
export {
  type KeyValueStore,
  type KvCondition,
  type KvItem,
  type KvKey,
  type KvOp,
  type KvRange,
  createKvAdapter,
} from "./engine/database/kv/kvAdapter";
export {
  type SqlConnection,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  WRITE_GUARD_TABLE,
  createSqlAdapter,
} from "./engine/database/sql/sqlAdapter";
export {
  type SqlDialect,
  createTableStatements,
  isMultiIndex,
} from "./engine/database/sql/sqlSchema";
export {
  type PluginTables,
  coreSchema,
  coreSettings,
  coreTarget,
  createEngineDatabase,
  migrateCoreSchema,
  toolingTargetOf,
} from "./engine/db/coreDatabase";
export { generateEngineSql } from "./engine/db/engineSql";
export { writeSchemaSettings } from "./engine/db/schemaSettings";
export {
  type DatabaseTooling,
  type Migrator,
  type SchemaGenerator,
  type ToolingDatabase,
  type ToolingTarget,
} from "./engine/db/types";
