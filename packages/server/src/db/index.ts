import {
  getHotUpdaterCoreMetadata,
  type RuntimeHotUpdaterAPI,
} from "../createHotUpdaterCore";
import { generateSchemaFromHotUpdaterSchema } from "./schemaGenerators";
import {
  type Migrator,
  type SchemaGenerator,
  type SchemaProvisioner,
} from "./types";

export * from "./createBundleDiff";
export {
  createMongoInsightsPreparation,
  MongoInsightsPreparationConflictError,
} from "./mongoInsightsPreparation";
export {
  createMongoInsightsSource,
  MongoInsightsSourceConflictError,
} from "./mongoInsightsSource";
export type { Migrator, SchemaGenerator, SchemaProvisioner } from "./types";
export {
  HotUpdaterInsightsSchemaProvisioningRequiredError,
  HotUpdaterSchemaMigrationRequiredError,
} from "./schemaReadiness";
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

export function createInsightsSchemaProvisioner(
  hotUpdater: HotUpdaterDBTarget,
): SchemaProvisioner | undefined {
  const { adapterCapabilities } = getDBMetadata(hotUpdater);
  return adapterCapabilities.createInsightsSchemaProvisioner?.();
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
