/**
 * What database providers and database adapter authors build on: the
 * database adapter contract, the SQL core and key-value helper that
 * implement it, `createEngineDatabase`, which puts an adapter behind the
 * schema fence as a provider's database, the `EngineDatabase` type a
 * provider returns, core's schema and settings, which its migration writes,
 * and `toolingTargetOf`, which adds a list of plugins' tables.
 */
export {
  compareTuples,
  compareUtf8,
  createMemoryAdapter,
  DATABASE_MAX_MULTI_VALUES,
  DATABASE_MAX_QUERY_LIMIT,
  DATABASE_VERSION_COLUMN,
  DatabaseAdapterContractError,
  DatabaseSchemaError,
  DatabaseValueError,
  expiresAt,
  indexOrderColumns,
  normalizeStoredRow,
  normalizeStoredValue,
  verifyAdapter,
  type DatabaseAdapter,
  type DatabaseJson,
  type DatabaseKey,
  type DatabaseKeyValue,
  type DatabaseReadCount,
  type DatabaseReadMeter,
  type DatabaseValue,
  type MemoryAdapterOptions,
  type NormalizeOptions,
  type PhysicalColumn,
  type PhysicalColumnType,
  type PhysicalIndex,
  type PhysicalRetention,
  type PhysicalTable,
  type QueryBound,
  type QueryRequest,
  type StoredRow,
  type VerifiedDatabaseAdapter,
  type VerifyAdapterOptions,
  type WriteGuard,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core/internal";

export type {
  AggregateBatching,
  EngineDatabase,
} from "@hot-updater/plugin-core";

export {
  MAX_SHARDS,
  resolveSchema,
  SHARD_COLUMN,
  validateSchema,
  type ResolvedModel,
  type ResolvedReference,
  type ResolvedSchema,
  type SchemaModule,
} from "./resolveSchema";
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
} from "./schema";
export { DatabaseCursorError } from "./cursor";
export { aggregateBatchingModule } from "./aggregateBatching";
export {
  createEngine,
  type DatabaseEngineOptions,
  type Engine,
  type ReadMeasurement,
} from "./engine";
export {
  createDatabaseEngine,
  type AggregateChanges,
  type AggregateIdentity,
  type AggregateRow,
  type CreateRow,
  type DatabaseEngine,
  type EngineColumns,
  type FindAggregatesModel,
  type FindManyModel,
  type HotUpdaterDatabase,
  type HotUpdaterTransaction,
  type KeyLookup,
  type Lookup,
  type ReadOptions,
  type ReadRow,
  type TableRow,
  type UpdateSet,
} from "./database";
export {
  DatabaseAmbiguousCommitError,
  DatabaseConflictError,
  DatabaseConstraintError,
  DatabaseTransactionError,
  type ConstraintReason,
} from "./errors";
export { type RetryOptions } from "./engineTransaction";
export {
  DatabaseQueryError,
  type EngineReadCount,
  type Page,
  type ReadRange,
} from "./engineReads";
export {
  classifySqlError,
  createSqlAdapter,
  createTableStatements,
  type SqlAdapterOptions,
  type SqlConnection,
  type SqlDialect,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  WRITE_GUARD_TABLE,
} from "./sql/sqlAdapter";
export {
  createKvAdapter,
  encodeKvKey,
  type KeyValueStore,
  type KvAdapterOptions,
  type KvCondition,
  type KvItem,
  type KvKey,
  type KvOp,
  type KvRange,
} from "./kv/kvAdapter";
export { isMultiIndex } from "./sql/sqlSchema";
export {
  coreSchema,
  coreSettings,
  coreTarget,
  createEngineDatabase,
  migrateCoreSchema,
  toolingTargetOf,
  type EngineDatabaseOptions,
  type PluginTables,
} from "../db/coreDatabase";
export { migrateSchema, writeSchemaSettings } from "../db/schemaSettings";
export {
  checkSchemaFence,
  isMissingSchemaError,
  ENGINE_SCHEMA_KEY,
  ENGINE_SCHEMA_VERSION,
  SETTINGS_TABLE,
  withSchemaFence,
  type SchemaSettings,
} from "./fence";
