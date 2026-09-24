import {
  getHotUpdaterCoreMetadata,
  type RuntimeHotUpdaterAPI,
} from "../createHotUpdaterCore";
import { type Migrator, type SchemaGenerator } from "./types";

export { createDatabaseCoreApi, type CoreApi } from "../core/api";
export { createDatabasePluginApis } from "../assembly/databasePlugins";
export { targetBaseCandidateKey } from "../core/baseCandidates";
export * from "./createBundleDiff";
export {
  generateEngineSql,
  settingsStatements,
  type EngineSqlOptions,
} from "./engineSql";
export type {
  DatabaseTooling,
  Migrator,
  SchemaGenerator,
  ToolingDatabase,
} from "./types";
export { HotUpdaterSchemaMigrationRequiredError } from "../database/fence";
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
  const { database } = getDBMetadata(hotUpdater);
  if (database.createMigrator === undefined) {
    throw new Error(
      `The ${database.name} database has no migrator; its provider applies the schema.`,
    );
  }
  return database.createMigrator();
}

export function generateSchema(
  hotUpdater: HotUpdaterDBTarget,
  ...args: Parameters<SchemaGenerator>
): ReturnType<SchemaGenerator> {
  const { database } = getDBMetadata(hotUpdater);
  if (database.generateSchema === undefined) {
    throw new Error(
      `The ${database.name} database has no schema generator; run \`hot-updater db migrate\` instead.`,
    );
  }
  return database.generateSchema(...args);
}
