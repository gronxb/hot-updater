import {
  getHotUpdaterCoreMetadata,
  type RuntimeHotUpdaterAPI,
} from "../createHotUpdaterCore";
import { type Migrator, type SchemaGenerator } from "./types";

export * from "./createBundleDiff";
export {
  foreignKeyStatements,
  generateEngineSql,
  settingsStatements,
  type EngineSqlOptions,
} from "./engineSql";
export type { Migrator, SchemaGenerator } from "./types";
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
  return (adapterCapabilities.generateSchema ?? core.generateSchema)(...args);
}
