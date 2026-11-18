import type { DatabaseAdapter } from "../../database/adapter";
import { HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import type { SchemaSettings } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import { getEmptyMigrationResult } from "./fixedMigratorShared";
import { fillLateIndexes, migrateSchema } from "./schemaSettings";
import {
  refuseNewerSchema,
  refuseV0Database,
  settingsOperation,
  storedSchemaVersion,
} from "./settingsMigrator";
import type { MigrateOptions, MigrationResult, Migrator } from "./types";

export interface EngineMigratorOptions {
  readonly adapterName: string;
  /** An adapter whose `migrations` create its tables and indexes. */
  readonly adapter: DatabaseAdapter;
  readonly schema: ResolvedSchema;
  readonly settings: SchemaSettings;
  /** The settings whose versions only move forward; `ToolingTarget.ordered`. */
  readonly ordered?: readonly string[];
  /** Every settings row by key and value, whatever the layout, so a v0 database is recognized. */
  readonly readSettings: () => Promise<ReadonlyMap<string, unknown>>;
}

/**
 * `hot-updater db migrate` for a store whose adapter creates its own tables
 * (MongoDB and the key-value stores): the tables and indexes, then the
 * settings rows, applied when a setting is missing or different, and refused
 * on a v0 database or one a newer release migrated.
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
    refuseNewerSchema(
      options.adapterName,
      stored,
      options.settings,
      options.ordered,
    );
    const changed = Object.entries(options.settings).filter(
      ([key, value]) => stored.get(key) !== value,
    );
    if (changed.length === 0) {
      // Up to date, but for late index items an earlier release's server
      // wrote rows without.
      const lacking = await fillLateIndexes(
        options.adapter,
        options.schema.tables,
        { dryRun: true },
      );
      if (lacking.length === 0) return getEmptyMigrationResult();
      return {
        operations: [
          {
            type: "custom",
            description: `Write the index items rows lack: ${lacking.join(", ")}`,
          },
        ],
        execute: async () => {
          await fillLateIndexes(options.adapter, options.schema.tables);
        },
      };
    }
    // The store creates what is missing and leaves what exists; it cannot
    // tell which, so the plan names the step once.
    return {
      operations: [
        {
          type: "custom",
          description: "Create the tables and indexes the database lacks",
        },
        ...(migrate.updateSettings === false
          ? []
          : [settingsOperation(stored, changed)]),
      ],
      execute: () =>
        migrateSchema(
          options.adapter,
          options.adapterName,
          options.schema.tables,
          options.settings,
          options.ordered,
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
