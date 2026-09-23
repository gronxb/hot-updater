import {
  ENGINE_SCHEMA_KEY,
  ENGINE_SCHEMA_VERSION,
  isMissingSchemaError,
  SETTINGS_TABLE,
  type SchemaSettings,
} from "../database/fence";
import type { SqlExecutor } from "../database/sql/sqlAdapter";
import { quoteSql } from "../database/sql/sqlSchema";
import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import { settingsStatements } from "./engineSql";
import {
  assertSupportedMigrationMode,
  getEmptyMigrationResult,
} from "./fixedMigratorShared";
import { HotUpdaterSchemaMigrationRequiredError } from "./schemaReadiness";
import type { MigrateOptions, MigrationResult, Migrator } from "./types";

/**
 * Every settings row by key and value alone, so a v0 layout reads too; null
 * when the settings table is missing.
 */
export const readStoredSettings = async (
  executor: SqlExecutor,
  tablePrefix = "",
): Promise<ReadonlyMap<string, unknown> | null> => {
  const quote = (name: string) => quoteSql(executor.dialect, name);
  try {
    const { rows } = await executor.execute({
      sql: `SELECT ${quote("key")}, ${quote("value")} FROM ${quote(tablePrefix + SETTINGS_TABLE.name)}`,
      params: [],
    });
    return new Map(rows.map((row) => [String(row.key), row.value]));
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    return null;
  }
};

/** `schema.core`, or a v0 database's `version`. */
export const storedSchemaVersion = (
  stored: ReadonlyMap<string, unknown> | null,
): string | undefined => {
  const version = stored?.get("schema.core") ?? stored?.get("version");
  return typeof version === "string" ? version : undefined;
};

/** A v0 or pre-engine database is recreated, never converted. */
export const refusePreEngineDatabase = (
  adapterName: string,
  stored: ReadonlyMap<string, unknown>,
): void => {
  const version = storedSchemaVersion(stored);
  if (version === undefined || stored.has(ENGINE_SCHEMA_KEY)) return;
  throw new HotUpdaterSchemaMigrationRequiredError(
    adapterName,
    version,
    stored.has("schema.core")
      ? { key: ENGINE_SCHEMA_KEY, expected: ENGINE_SCHEMA_VERSION, found: null }
      : undefined,
  );
};

/**
 * `hot-updater db migrate` for an ORM that applies the DDL itself (Drizzle,
 * Prisma): it sets what the ORM cannot declare, writes the settings rows, and
 * refuses a v0 or pre-engine database.
 */
export const createSettingsMigrator = (options: {
  readonly adapterName: string;
  readonly executor: SqlExecutor;
  readonly settings: SchemaSettings;
  /** How the ORM applies the tables, for the error when they are missing. */
  readonly applyTables: string;
  /** What the ORM cannot declare, set before the settings rows. */
  readonly fixups?: {
    readonly description: string;
    readonly statements: readonly string[];
  };
}): Migrator => {
  const read = () => readStoredSettings(options.executor);
  const getVersion = async () => storedSchemaVersion(await read());

  const makeResult = async (
    migrate: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    assertSupportedMigrationMode(migrate);
    const stored = await read();
    if (stored === null) {
      throw new Error(
        `${options.adapterName}: the Hot Updater tables are missing. Run \`hot-updater db generate\`, apply the schema with ${options.applyTables}, then migrate again.`,
      );
    }
    refusePreEngineDatabase(options.adapterName, stored);
    if (
      migrate.updateSettings === false ||
      Object.entries(options.settings).every(
        ([key, value]) => stored.get(key) === value,
      )
    ) {
      return getEmptyMigrationResult();
    }
    const fixups = options.fixups?.statements ?? [];
    const statements = [
      ...fixups,
      ...settingsStatements(options.executor.dialect, options.settings),
    ];
    return {
      operations: [
        ...(fixups.length === 0
          ? []
          : [
              {
                type: "custom" as const,
                description: options.fixups!.description,
              },
            ]),
        {
          type: "custom",
          description: `Write the schema settings: ${Object.keys(options.settings).join(", ")}`,
        },
      ],
      getSQL: () => statements.map((statement) => `${statement};`).join("\n\n"),
      execute: async () => {
        for (const sql of statements) {
          await options.executor.execute({ sql, params: [] });
        }
      },
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
