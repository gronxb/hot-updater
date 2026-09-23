import type { DatabaseAdapter } from "@hot-updater/plugin-core/internal";

import { migrateSchema, type SchemaSettings } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import {
  assertSupportedMigrationMode,
  getEmptyMigrationResult,
} from "./fixedMigratorShared";
import {
  refusePreEngineDatabase,
  storedSchemaVersion,
} from "./settingsMigrator";
import type { MigrateOptions, MigrationResult, Migrator } from "./types";

export interface EngineMigratorOptions {
  readonly adapterName: string;
  /** An adapter whose `migrations` create its tables and indexes. */
  readonly adapter: DatabaseAdapter;
  readonly schema: ResolvedSchema;
  readonly settings: SchemaSettings;
  /** Every settings row by key and value, whatever the layout, so an older database is recognized. */
  readonly readSettings: () => Promise<ReadonlyMap<string, unknown>>;
}

/**
 * `hot-updater db migrate` for a store whose adapter creates its own tables
 * (MongoDB and the key-value stores): the tables and indexes, then the
 * settings rows, applied when a setting is missing or different, and refused
 * on a database from before the engine.
 */
export const createEngineMigrator = (
  options: EngineMigratorOptions,
): Migrator => {
  const getVersion = async () =>
    storedSchemaVersion(await options.readSettings());

  const makeResult = async (
    migrate: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    assertSupportedMigrationMode(migrate);
    const stored = await options.readSettings();
    refusePreEngineDatabase(options.adapterName, stored);
    if (
      Object.entries(options.settings).every(
        ([key, value]) => stored.get(key) === value,
      )
    ) {
      return getEmptyMigrationResult();
    }
    return {
      operations: [
        ...options.schema.tables.map((table) => ({
          type: "create-table" as const,
          value: {
            ormName: table.name,
            columns: Object.fromEntries(
              table.columns.map((column) => [
                column.name,
                { ormName: column.name, type: column.type },
              ]),
            ),
          },
        })),
        ...(migrate.updateSettings === false
          ? []
          : [
              {
                type: "custom" as const,
                description: `Write the schema settings: ${Object.keys(options.settings).join(", ")}`,
              },
            ]),
      ],
      execute: () =>
        migrateSchema(
          options.adapter,
          options.adapterName,
          options.schema.tables,
          options.settings,
        ),
    };
  };

  return {
    getVersion,
    getNameVariants: async () => undefined,
    next: async () =>
      (await getVersion()) === HOT_UPDATER_SCHEMA_VERSION
        ? undefined
        : { version: HOT_UPDATER_SCHEMA_VERSION },
    previous: async () => undefined,
    up: makeResult,
    down: async () => {
      throw new Error("No previous schema to migrate to.");
    },
    migrateTo: async (version, migrate) => {
      if (version !== HOT_UPDATER_SCHEMA_VERSION) {
        throw new Error(`Invalid version ${version}`);
      }
      return makeResult(migrate);
    },
    migrateToLatest: makeResult,
  };
};
