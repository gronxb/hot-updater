export * from "./bundleStorageLayout";
export * from "./bundlePatchLimits";
export * from "./bundlePackagingLimits";
export * from "./bundleManifestValidation";
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
export {
  isDatabaseJsonObject,
  isDatabaseMetadataObject,
} from "./databaseJsonValue";
export * from "./databaseRows";
export * from "./deterministicOrder";
export * from "./filterCompatibleAppVersions";
export * from "./generateMinBundleId";
export * from "./parseStorageUri";
export * from "./portableArtifactPath";
export * from "./releaseCatalogCompiler";
export * from "./releaseManagement";
export * from "./releaseCatalogMutation";
export * from "./remoteBundleSigning";
export * from "./semverSatisfies";
export * from "./types";
export * from "./uuidv7";

// The server plugin authoring API: `definePlugin`, the schema DSL, the typed
// database handle, core's reads, and the errors a plugin handles.
// `@hot-updater/plugin-core` re-exports it for plugin authors; Hot
// Updater's own plugin packages import it here, below the server.
export {
  definePlugin,
  type AnyHotUpdaterPlugin,
  type ClientAuth,
  type CoreReader,
  type HotUpdaterPlugin,
  type PluginApis,
  type PluginCli,
  type PluginClientCredential,
  type PluginClientPlugin,
  type PluginContext,
  type PluginEndpoint,
  type PluginEndpointMethod,
  type PluginInstance,
  type PluginProvides,
} from "./serverPlugin/definePlugin";
export {
  defineAggregate,
  defineTable,
  type AggregateDefinition,
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
// adapters, the storage engine and its databases, and core's schema. Each
// name is here because the custom-database docs teach it or because an
// adapter, a provider's tooling, or a plugin outside this package needs it;
// its JSDoc says which.
export {
  type BaseCandidateQuery,
  type BaseCandidateTarget,
  parseBaseCandidateKey,
  targetBaseCandidateKey,
} from "./baseCandidateKey";
export {
  type DatabaseAdapter,
  type DatabaseJson,
  type DatabaseKey,
  type DatabaseKeyValue,
  DATABASE_VERSION_COLUMN,
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
  findPhysicalColumn,
  findPhysicalIndex,
  indexOrderColumns,
  rowKey,
} from "./database/adapter";
export {
  type MemoryAdapterOptions,
  createMemoryAdapter,
} from "./database/memoryAdapter";
export {
  type NormalizeOptions,
  compareUtf8,
  normalizeStoredRow,
} from "./database/values";
export {
  DatabaseAdapterContractError,
  type DatabaseReadCount,
  type DatabaseReadMeter,
  type VerifiedDatabaseAdapter,
  type VerifyAdapterOptions,
  verifyAdapter,
} from "./database/verifyAdapter";
export type { CoreSchema } from "./engine/core/schema";
export {
  type Engine,
  type EngineOptions,
  createEngine,
} from "./engine/createEngine";
export type { EngineReadCount } from "./engine/database/engineReads";
export type { RetryOptions } from "./engine/database/engineTransaction";
export {
  HotUpdaterSchemaMigrationRequiredError,
  SETTINGS_TABLE,
  type SchemaSettings,
} from "./engine/database/fence";
export {
  type KeyValueStore,
  type KvAdapterOptions,
  type KvCondition,
  type KvItem,
  type KvKey,
  type KvOp,
  type KvRange,
  createKvAdapter,
  encodeKvKey,
} from "./engine/database/kv/kvAdapter";
export {
  type MeteredDatabase,
  type ReadMeasurement,
  meterReads,
} from "./engine/database/readMeter";
export type {
  ResolvedModel,
  ResolvedSchema,
} from "./engine/database/resolveSchema";
export {
  type SqlAdapterOptions,
  type SqlConnection,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  WRITE_GUARD_TABLE,
  createSqlAdapter,
} from "./engine/database/sql/sqlAdapter";
export {
  type SqlColumnShape,
  type SqlDialect,
  type SqlTableShape,
  createTableStatements,
  isMultiIndex,
  quoteSql,
  sqlTableShapes,
} from "./engine/database/sql/sqlSchema";
export {
  type EngineDatabaseOptions,
  type PluginTables,
  aggregateBatchingTables,
  coreSchema,
  coreSettings,
  coreTarget,
  createEngineDatabase,
  migrateCoreSchema,
  toolingTargetOf,
} from "./engine/db/coreDatabase";
export {
  type EngineSqlOptions,
  generateEngineSql,
} from "./engine/db/engineSql";
export {
  type EngineSqlMigratorOptions,
  createEngineSqlMigrator,
} from "./engine/db/engineSqlMigrator";
export { writeSchemaSettings } from "./engine/db/schemaSettings";
export { createSettingsMigrator } from "./engine/db/settingsMigrator";
export {
  type DatabaseTooling,
  type MigrateOptions,
  type MigrationResult,
  type Migrator,
  type SchemaGenerator,
  type ToolingDatabase,
  type ToolingTarget,
} from "./engine/db/types";
