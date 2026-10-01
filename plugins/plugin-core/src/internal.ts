export {
  type AdapterResource,
  adapterResourceOf,
  withAdapterResource,
} from "./adapterResource";
export { DatabaseRowReferencedError } from "./databaseErrors";
export { isDatabaseJsonObject } from "./databaseJsonValue";
export type * from "./types/internal";

export * from "./database";

// Hot Updater's own packages: the schema shapes the server resolves, and the
// brand that tells its official plugins apart.
export type {
  AggregateShape,
  DerivedShape,
  ModelShape,
  SchemaShape,
  TableShape,
} from "./serverPlugin/definitions";
export {
  checkReservedId,
  isOfficialPlugin,
  markOfficial,
} from "./serverPlugin/official";

// The storage engine, for Hot Updater's own packages.
export {
  type CoreSchema,
  HOT_UPDATER_SCHEMA_VERSION,
  coreModule,
} from "./engine/core/schema";
export { aggregateBatchingModule } from "./engine/database/aggregateBatching";
export {
  type DatabaseEngine,
  createDatabaseEngine,
} from "./engine/database/database";
export {
  type DatabaseEngineOptions,
  type Engine,
  type ReadMeasurement,
  createEngine,
} from "./engine/database/engine";
export { shardOf } from "./engine/database/engineAggregates";
export {
  type EngineReadCount,
  type ReadRange,
} from "./engine/database/engineReads";
export { type RetryOptions } from "./engine/database/engineTransaction";
export {
  ENGINE_SCHEMA_KEY,
  ENGINE_SCHEMA_VERSION,
  HotUpdaterSchemaMigrationRequiredError,
  SETTINGS_TABLE,
  type SchemaSettings,
  checkSchemaFence,
  fencedName,
  isMissingSchemaError,
  withSchemaFence,
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
  MAX_SHARDS,
  type ResolvedModel,
  type ResolvedReference,
  type ResolvedSchema,
  SHARD_COLUMN,
  type SchemaModule,
  resolveSchema,
  validateSchema,
} from "./engine/database/resolveSchema";
export { pruneDuringWrites } from "./engine/database/retention";
export {
  type SqlAdapterOptions,
  type SqlConnection,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  WRITE_GUARD_TABLE,
  classifySqlError,
  createSqlAdapter,
} from "./engine/database/sql/sqlAdapter";
export {
  type SqlColumnShape,
  type SqlDialect,
  type SqlTableShape,
  createTableStatements,
  isMultiIndex,
  pruneStatements,
  quoteSql,
  sqlTableShapes,
} from "./engine/database/sql/sqlSchema";
export {
  type EngineDatabaseOptions,
  type PluginTables,
  coreSchema,
  coreSettings,
  coreTarget,
  createEngineDatabase,
  migrateCoreSchema,
  pluginModule,
  pluginSettings,
  toolingTargetOf,
} from "./engine/db/coreDatabase";
export { createEngineMigrator } from "./engine/db/engineMigrator";
export {
  type EngineSqlOptions,
  generateEngineSql,
  settingsStatements,
} from "./engine/db/engineSql";
export {
  assertSupportedMigrationMode,
  getEmptyMigrationResult,
} from "./engine/db/fixedMigratorShared";
export { migrateSchema, writeSchemaSettings } from "./engine/db/schemaSettings";
export {
  createSettingsMigrator,
  readStoredSettings,
  refusePreEngineDatabase,
  storedSchemaVersion,
} from "./engine/db/settingsMigrator";
export {
  type DatabaseTooling,
  type MigrateOptions,
  type MigrationResult,
  type Migrator,
  type ORMSQLProvider,
  type SchemaGenerator,
  type ToolingDatabase,
  type ToolingTarget,
  sqlProviders,
} from "./engine/db/types";
export {
  type EngineColumns,
  type FindAggregatesModel,
  type FindManyModel,
  type KeyLookup,
} from "./serverPlugin/databaseHandle";
export {
  type CheckIndex,
  type DerivedFields,
  type FieldValue,
  type ModelDefinition,
  type RowOf,
} from "./serverPlugin/schema";
export {
  type AggregateBatching,
  type EngineDatabase,
} from "./types/databaseConfig";
