import {
  getHotUpdaterCoreMetadata,
  type RuntimeHotUpdaterAPI,
} from "../createHotUpdaterCore";
import { generateSchemaFromHotUpdaterSchema } from "./schemaGenerators";
import { type Migrator, type SchemaGenerator } from "./types";

export * from "./createBundleDiff";
export type { Migrator, SchemaGenerator } from "./types";
export { HotUpdaterSchemaMigrationRequiredError } from "./schemaReadiness";
export { HOT_UPDATER_SERVER_VERSION } from "../version";

export type HotUpdaterDBTarget = {
  readonly adapterName: string;
  readonly authorityId: string;
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
  const migrator = (
    adapterCapabilities.createMigrator ?? core.createMigrator
  )();
  const options = (
    input: Parameters<Migrator["up"]>[0],
  ): NonNullable<Parameters<Migrator["up"]>[0]> => ({
    ...input,
    authorityId: hotUpdater.authorityId,
  });
  return {
    ...migrator,
    up: (input) => migrator.up(options(input)),
    down: (input) => migrator.down(options(input)),
    migrateTo: (version, input) => migrator.migrateTo(version, options(input)),
    migrateToLatest: (input) => migrator.migrateToLatest(options(input)),
  };
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
