import {
  getHotUpdaterCoreMetadata,
  type RuntimeHotUpdaterAPI,
} from "../createHotUpdaterCore";
import { type Migrator, type SchemaGenerator } from "./types";

export { createDatabaseCoreApi, type CoreApi } from "../core/api";
export {
  createDatabasePluginApis,
  createMeasuredDatabase,
  type MeasuredDatabase,
  type MeasuredDatabaseOptions,
} from "../assembly/databasePlugins";
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
  ToolingTarget,
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

/** Whether `hot-updater db generate` writes schema files for a server's database. */
export const generatesSchema = (hotUpdater: HotUpdaterDBTarget): boolean =>
  getDBMetadata(hotUpdater).database.generateSchema !== undefined;

/** The migrator for a server's database: its built-in tables and its plugins' tables. */
export function createMigrator(hotUpdater: HotUpdaterDBTarget): Migrator {
  const { database, target } = getDBMetadata(hotUpdater);
  if (database.createMigrator === undefined) {
    throw new Error(
      database.generateSchema === undefined
        ? `The ${database.name} database has no migrator; its provider applies the schema.`
        : `The ${database.name} database applies its schema from migration files: run \`hot-updater db generate\`, then apply the file with the provider's tooling.`,
    );
  }
  return database.createMigrator(target);
}

export function generateSchema(
  hotUpdater: HotUpdaterDBTarget,
  ...args: Parameters<SchemaGenerator>
): ReturnType<SchemaGenerator> {
  const { database, target } = getDBMetadata(hotUpdater);
  if (database.generateSchema === undefined) {
    throw new Error(
      `The ${database.name} database has no schema generator; run \`hot-updater db migrate\` instead.`,
    );
  }
  const [version, name] = args;
  return database.generateSchema(version, name, target);
}
