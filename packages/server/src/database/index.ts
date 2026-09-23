/**
 * The storage adapter contract of the database redesign.
 *
 * Unstable: this subpath may change in any release until the redesign makes
 * it public.
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
