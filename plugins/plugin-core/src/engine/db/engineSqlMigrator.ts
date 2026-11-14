import { HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import type { SchemaSettings } from "../database/fence";
import { SETTINGS_TABLE } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import type { SqlExecutor } from "../database/sql/sqlAdapter";
import {
  quoteSql,
  sqlTableShapes,
  type SqlTableShape,
} from "../database/sql/sqlSchema";
import {
  type EngineSqlOptions,
  generateEngineSql,
  settingsStatements,
} from "./engineSql";
import { getEmptyMigrationResult } from "./fixedMigratorShared";
import {
  readStoredSettings,
  refuseV0Database,
  storedSchemaVersion,
} from "./settingsMigrator";
import type { MigrateOptions, MigrationResult, Migrator } from "./types";

export interface EngineSqlMigratorOptions extends EngineSqlOptions {
  readonly adapterName: string;
  readonly executor: SqlExecutor;
  readonly schema: ResolvedSchema;
  readonly settings: SchemaSettings;
}

/** Each table, and the index tables of its multi-valued indexes. */
const flatten = (shapes: readonly SqlTableShape[]): SqlTableShape[] =>
  shapes.flatMap((shape) => [
    shape,
    ...flatten(
      shape.indexes.flatMap((index) =>
        index.kind === "table" ? [index.table] : [],
      ),
    ),
  ]);

/**
 * MySQL declares a table's indexes in its CREATE TABLE, which a table an
 * earlier release created skips, and has no CREATE INDEX IF NOT EXISTS: the
 * indexes the tables lack, created one by one.
 */
const missingMysqlIndexes = async (
  executor: SqlExecutor,
  schema: ResolvedSchema,
  tablePrefix?: string,
): Promise<string[]> => {
  const quote = (name: string) => quoteSql("mysql", name);
  const { rows } = await executor.execute({
    sql: "SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS i FROM information_schema.statistics WHERE TABLE_SCHEMA = DATABASE()",
    params: [],
  });
  const present = new Set(rows.map(({ t, i }) => JSON.stringify([t, i])));
  return flatten(
    sqlTableShapes("mysql", [...schema.tables, SETTINGS_TABLE], tablePrefix),
  ).flatMap((shape) =>
    shape.indexes.flatMap((index) =>
      index.kind === "index" &&
      !present.has(JSON.stringify([shape.name, index.name]))
        ? [
            `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${quote(shape.name)} (${index.columns.map(quote).join(", ")})`,
          ]
        : [],
    ),
  );
};

/**
 * Runs the tables' statements, then the settings rows last, in one
 * transaction where the dialect's DDL is transactional. On MySQL the indexes
 * existing tables lack go between them, so the settings move only once
 * every index exists.
 */
const run = async (
  executor: SqlExecutor,
  tables: readonly string[],
  settings: readonly string[],
  schema: ResolvedSchema,
  tablePrefix?: string,
) => {
  const each = async (
    connection: Pick<SqlExecutor, "execute">,
    sqls: readonly string[],
  ) => {
    for (const sql of sqls) await connection.execute({ sql, params: [] });
  };
  if (executor.dialect !== "mysql") {
    await executor.transaction((connection) =>
      each(connection, [...tables, ...settings]),
    );
    return;
  }
  await each(executor, tables);
  await each(
    executor,
    await missingMysqlIndexes(executor, schema, tablePrefix),
  );
  await each(executor, settings);
};

/**
 * `hot-updater db migrate` and `db generate` for an SQL provider on the
 * engine: the generated SQL schema, applied when a settings row is missing or
 * different, and refused on a v0 database. A SQL adapter's `createMigrator`
 * returns it, as `kyselyAdapter`'s does.
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
    const stored = await read();
    refuseV0Database(options.adapterName, stored);
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
    const settingsSql = settingsStatements(
      options.executor.dialect,
      options.settings,
      options.tablePrefix,
    );
    const tablesSql = statements.slice(0, -settingsSql.length || undefined);
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
      execute: () =>
        run(
          options.executor,
          tablesSql,
          settingsSql,
          options.schema,
          options.tablePrefix,
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
