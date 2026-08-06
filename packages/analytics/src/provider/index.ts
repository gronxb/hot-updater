export type {
  ActiveInstallationInput,
  ActiveInstallationOverview,
  ActiveInstallationWindow,
  AnalyticsCohortPoint,
  AnalyticsSeriesPoint,
  BundleEventAnalyticsResult,
  BundleEventAnalyticsWindow,
  BundleEventOverview,
  BundleEventSummary,
  CreateBundleEventRequest,
  CreateBundleEventRequestBase,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
} from "../domain.js";
export {
  AnalyticsScanLimitExceededError,
  AnalyticsUnavailableError,
  InvalidAnalyticsCapabilityError,
  InvalidAnalyticsProviderError,
} from "../errors.js";
export { createBoundedAnalyticsProvider } from "./bounded/provider.js";
export {
  migrateLegacyAnalyticsBlob,
  type AnalyticsBlobCoreHandle,
  type AnalyticsBlobMigrationOperations,
} from "./blobMigration.js";
export {
  ANALYTICS_BLOB_DATA_PREFIX,
  ANALYTICS_BLOB_KEY,
  ANALYTICS_BLOB_PENDING_KEY,
  AnalyticsBlobFormatError,
  AnalyticsBlobWriteConflictError,
  createBlobAnalyticsPersistence,
  loadActiveAnalyticsBlob,
  loadAnalyticsBlobByPointer,
  parseAnalyticsBlob,
  parseAnalyticsBlobPointer,
  stageAnalyticsBlobData,
  type AnalyticsBlobOperations,
} from "./blobPersistence.js";
export {
  ANALYTICS_SCHEMA_FINGERPRINT_V1,
  ANALYTICS_SCHEMA_FINGERPRINT_V2,
  ANALYTICS_SCHEMA_KEY,
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSchemaCompatibilityError,
  AnalyticsSchemaNotReadyError,
  migrateAnalyticsSchema,
  type AnalyticsMigrationResult,
  type AnalyticsSchemaInspection,
  type AnalyticsSchemaMigrationStore,
  type AnalyticsSchemaShape,
} from "./migration.js";
export type {
  AnalyticsPersistence,
  AnalyticsScanCursor,
  AnalyticsScanInput,
  BundleEventPersistenceRow,
} from "./persistence.js";
export {
  InvalidBundleEventPersistenceRowError,
  parseBundleEventPersistenceRow,
} from "./rowParser.js";
export {
  ANALYTICS_PHYSICAL_SCHEMA_V1,
  ANALYTICS_PHYSICAL_SCHEMA_V2,
  fingerprintAnalyticsPhysicalSchema,
  type AnalyticsPhysicalColumn,
  type AnalyticsPhysicalIndex,
  type AnalyticsPhysicalSchema,
} from "./schemaFingerprint.js";
export {
  parseAnalyticsProvider,
  parseReportedAnalyticsCapability,
  resolveAnalyticsCapability,
} from "./token.js";
export type {
  AnalyticsProvider,
  AnalyticsProviderMode,
  ReportedAnalyticsCapability,
} from "./types.js";
