import { HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import type { SchemaSettings } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import type { SqlExecutor } from "../database/sql/sqlAdapter";
import { generateEngineSql, type EngineSqlOptions } from "./engineSql";
import {
  assertSupportedMigrationMode,
  getEmptyMigrationResult,
} from "./fixedMigratorShared";
import {
  readStoredSettings,
  refusePreEngineDatabase,
  storedSchemaVersion,
} from "./settingsMigrator";
import type { MigrateOptions, MigrationResult, Migrator } from "./types";

export interface EngineSqlMigratorOptions extends EngineSqlOptions {
  readonly adapterName: string;
  readonly executor: SqlExecutor;
  readonly schema: ResolvedSchema;
  readonly settings: SchemaSettings;
}

/** Runs the statements in one transaction where the dialect's DDL is transactional. */
const run = async (executor: SqlExecutor, statements: readonly string[]) => {
  const each = async (connection: Pick<SqlExecutor, "execute">) => {
    for (const sql of statements) await connection.execute({ sql, params: [] });
  };
  await (executor.dialect === "mysql"
    ? each(executor)
    : executor.transaction(each));
};

/**
 * `hot-updater db migrate` and `db generate` for an SQL provider on the
 * engine: the generated SQL schema, applied when a settings row is missing or
 * different, and refused on a database from before the engine.
 */
export const createEngineSqlMigrator = (
  options: EngineSqlMigratorOptions,
): Migrator => {
  /** No settings table yet reads as an empty database. */
  const read = async () =>
    (await readStoredSettings(options.executor, options.tablePrefix)) ??
    new Map<string, unknown>();
  const getVersion = async () => storedSchemaVersion(await read());

  const makeResult = async (
    migrate: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    assertSupportedMigrationMode(migrate);
    const stored = await read();
    // A database from before the engine is recreated, never converted.
    refusePreEngineDatabase(options.adapterName, stored);
    if (
      Object.entries(options.settings).every(
        ([key, value]) => stored.get(key) === value,
      )
    ) {
      return getEmptyMigrationResult();
    }
    const statements = generateEngineSql(
      options.executor.dialect,
      options.schema,
      options.settings,
      options,
    );
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
      getSQL: () => statements.map((statement) => `${statement};`).join("\n\n"),
      execute: () => run(options.executor, statements),
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
