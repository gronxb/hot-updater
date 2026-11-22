import { HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import {
  compareVersions,
  ENGINE_SCHEMA_KEY,
  isMissingSchemaError,
  SETTINGS_TABLE,
  type SchemaSettings,
} from "../database/fence";
import { HotUpdaterSchemaMigrationRequiredError } from "../database/fence";
import type { SqlExecutor } from "../database/sql/sqlAdapter";
import { quoteSql } from "../database/sql/sqlSchema";
import { settingsStatements } from "./engineSql";
import { getEmptyMigrationResult } from "./fixedMigratorShared";
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

/**
 * A v0 database, whose settings hold `version` and no `schema.engine`, is
 * recreated, never converted.
 */
export const refuseV0Database = (
  adapterName: string,
  stored: ReadonlyMap<string, unknown>,
): void => {
  const version = stored.get("version");
  if (typeof version !== "string" || stored.has(ENGINE_SCHEMA_KEY)) return;
  throw new HotUpdaterSchemaMigrationRequiredError(adapterName, version);
};

/**
 * The settings whose versions only move forward when a `ToolingTarget` names
 * none. `schema.engine` is a storage layout, not a release: a store refuses
 * another layout itself.
 */
export const DEFAULT_ORDERED_SETTINGS: readonly string[] = ["schema.core"];

/**
 * Refuses a database a newer release migrated, one whose `schema.core` is
 * newer than this release's: writing this release's settings would move the
 * schema back, and every server of the newer release would answer 503. Only
 * `ordered` settings are compared, `schema.core` among them, and the message
 * lists each that is newer. An official plugin's
 * newer version alone is no newer release: Insights recorded "1.2.0" in
 * 1.0.0-rc.23 and rc.24, then went back to "1.0.0" with the same tables.
 */
export const refuseNewerSchema = (
  adapterName: string,
  stored: ReadonlyMap<string, unknown>,
  settings: SchemaSettings,
  ordered: readonly string[] = DEFAULT_ORDERED_SETTINGS,
): void => {
  const newer = ordered.flatMap((key) => {
    const found = stored.get(key);
    const expected = settings[key];
    return typeof found === "string" &&
      expected !== undefined &&
      compareVersions(found, expected) > 0
      ? [{ key, found, expected }]
      : [];
  });
  const core = newer.find(({ key }) => key === "schema.core");
  if (core === undefined) return;
  throw new Error(
    `${adapterName}: the database was migrated by Hot Updater ${core.found} (${newer.map(({ key, found, expected }) => `${key} "${found}", this CLI's "${expected}"`).join("; ")}). Upgrade hot-updater to ${core.found} or later; nothing was written.`,
  );
};

/**
 * `hot-updater db migrate` for an ORM that applies the DDL itself (Drizzle,
 * Prisma): it sets what the ORM cannot declare, writes the settings rows, and
 * refuses a v0 database or one a newer release migrated. The `createMigrator` of an adapter whose ORM
 * creates the tables returns it, as the Drizzle and Prisma adapters' do.
 */
export const createSettingsMigrator = (options: {
  readonly adapterName: string;
  readonly executor: SqlExecutor;
  readonly settings: SchemaSettings;
  /** The settings whose versions only move forward; `ToolingTarget.ordered`. */
  readonly ordered?: readonly string[];
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
    const stored = await read();
    if (stored === null) {
      throw new Error(
        `${options.adapterName}: the Hot Updater tables are missing. Run \`hot-updater db generate\`, apply the schema with ${options.applyTables}, then migrate again.`,
      );
    }
    refuseV0Database(options.adapterName, stored);
    refuseNewerSchema(
      options.adapterName,
      stored,
      options.settings,
      options.ordered,
    );
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
