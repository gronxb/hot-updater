import type { DatabaseAdapter } from "../../database/adapter";
import { HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import type { SchemaSettings } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import { getEmptyMigrationResult } from "./fixedMigratorShared";
import { migrateSchema } from "./schemaSettings";
import { refuseV0Database, storedSchemaVersion } from "./settingsMigrator";
import type { MigrateOptions, MigrationResult, Migrator } from "./types";

export interface EngineMigratorOptions {
  readonly adapterName: string;
  /** An adapter whose `migrations` create its tables and indexes. */
  readonly adapter: DatabaseAdapter;
  readonly schema: ResolvedSchema;
  readonly settings: SchemaSettings;
  /** Every settings row by key and value, whatever the layout, so a v0 database is recognized. */
  readonly readSettings: () => Promise<ReadonlyMap<string, unknown>>;
}

/**
 * `hot-updater db migrate` for a store whose adapter creates its own tables
 * (MongoDB and the key-value stores): the tables and indexes, then the
 * settings rows, applied when a setting is missing or different, and refused
 * on a v0 database.
 */
export const createEngineMigrator = (
  options: EngineMigratorOptions,
): Migrator => {
  const getVersion = async () =>
    storedSchemaVersion(await options.readSettings());

  const makeResult = async (
    migrate: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    const stored = await options.readSettings();
    refuseV0Database(options.adapterName, stored);
    if (
      Object.entries(options.settings).every(
        ([key, value]) => stored.get(key) === value,
      )
    ) {
      // Up to date, but for index items a store keeps itself, such as an
      // index declared after rows a prerelease of this version wrote.
      const pending =
        (await options.adapter.migrations?.pending?.(options.schema.tables)) ??
        [];
      if (pending.length === 0) return getEmptyMigrationResult();
      return {
        operations: [
          {
            type: "custom",
            description: `Write the index items of rows stored before their index: ${pending.join(", ")}`,
          },
        ],
        execute: () =>
          migrateSchema(
            options.adapter,
            options.adapterName,
            options.schema.tables,
            options.settings,
          ),
      };
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
