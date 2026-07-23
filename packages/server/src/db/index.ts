import {
  getHotUpdaterCoreMetadata,
  type RuntimeHotUpdaterAPI,
} from "../createHotUpdaterCore";
import { generateSchemaFromHotUpdaterSchema } from "./schemaGenerators";
import { type Migrator, type SchemaGenerator } from "./types";

export * from "./createBundleDiff";
export type {
  BundleEventAnalyticsResult,
  BundleEventAnalyticsWindow,
  BundleEventAPI,
  BundleEventSummary,
  CreateBundleEventRequest,
  InstallationHistoryRow,
  InstallationSearchRow,
  Migrator,
  OffsetPaginationResult,
  SchemaGenerator,
} from "./types";
export type { AnalyticsCapability } from "./analyticsCapability";
export {
  getAnalyticsCapability,
  supportsAnalytics,
} from "./analyticsCapability";
export { BundleEventScanLimitExceededError } from "./bundleEventScan";
export { HotUpdaterSchemaMigrationRequiredError } from "./schemaReadiness";
export { HOT_UPDATER_SERVER_VERSION } from "../version";

export type HotUpdaterDBTarget = {
  readonly adapterName: string;
};

const getDBMetadata = (hotUpdater: HotUpdaterDBTarget) => {
  const metadata = getHotUpdaterCoreMetadata(
    hotUpdater as RuntimeHotUpdaterAPI,
  );
  if (!metadata) {
    throw new Error(
      "Database tooling requires a hotUpdater instance created by @hot-updater/server.",
    );
  }
  return metadata;
};

export function createMigrator(hotUpdater: HotUpdaterDBTarget): Migrator {
  const { adapterCapabilities, core } = getDBMetadata(hotUpdater);
  return (adapterCapabilities.createMigrator ?? core.createMigrator)();
}

export function generateSchema(
  hotUpdater: HotUpdaterDBTarget,
  ...args: Parameters<SchemaGenerator>
): ReturnType<SchemaGenerator> {
  const { adapterCapabilities, core } = getDBMetadata(hotUpdater);
  const schemaGenerator =
    adapterCapabilities.generateSchema ?? core.generateSchema;
  return generateSchemaFromHotUpdaterSchema(
    hotUpdater.adapterName,
    adapterCapabilities.provider,
    args[0],
    schemaGenerator(...args),
  );
}
