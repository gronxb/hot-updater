import { HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import {
  ENGINE_SCHEMA_KEY,
  isMissingSchemaError,
  SETTINGS_TABLE,
  type SchemaSettings,
} from "../database/fence";
import { HotUpdaterSchemaMigrationRequiredError } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import type { SqlExecutor } from "../database/sql/sqlAdapter";
import { quoteSql, type SqlColumnShape } from "../database/sql/sqlSchema";
import { settingsStatements } from "./engineSql";
import { getEmptyMigrationResult } from "./fixedMigratorShared";
import {
  addColumnStatements,
  collationStatements,
  missingSqlSchema,
  readSqlSchemaState,
  targetShapes,
  type MissingSqlSchema,
} from "./sqlSchemaState";
import type {
  MigrateOptions,
  MigrationOperation,
  MigrationResult,
  Migrator,
} from "./types";

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

/** Compares dotted numeric versions, such as "1" and "1.2.0"; NaN when either is not one. */
const compareVersions = (left: string, right: string): number => {
  const parse = (version: string) =>
    /^\d+(?:\.\d+)*$/u.test(version) ? version.split(".").map(Number) : [NaN];
  const [a, b] = [parse(left), parse(right)];
  if ([...a, ...b].some(Number.isNaN)) return Number.NaN;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * The settings whose versions only move forward when a `ToolingTarget` names
 * none. `schema.engine` is a storage layout, not a release: a store refuses
 * another layout itself, and doctor reports it as not migratable.
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
 * The tables, late columns or indexes an ORM has yet to apply, found before `db migrate`
 * writes the settings rows, so the fence never passes over missing tables.
 */
export class HotUpdaterSchemaTablesMissingError extends Error {
  constructor(
    readonly adapterName: string,
    readonly missing: MissingSqlSchema,
    /** The command that applies the generated schema. */
    readonly applyTables: string,
  ) {
    const all = missing.tables.includes(SETTINGS_TABLE.name);
    const items = [
      ...(missing.tables.length === 0
        ? []
        : [
            `table${missing.tables.length === 1 ? "" : "s"} ${missing.tables.join(", ")}`,
          ]),
      ...(missing.columns.length === 0
        ? []
        : [
            `column${missing.columns.length === 1 ? "" : "s"} ${missing.columns.map(({ table, column }) => `${table}.${column.name}`).join(", ")}`,
          ]),
      ...(missing.indexes.length === 0
        ? []
        : [
            `index${missing.indexes.length === 1 ? "" : "es"} ${missing.indexes.map(({ index }) => index).join(", ")}`,
          ]),
    ];
    super(
      `${adapterName}: ${all ? "the Hot Updater tables are missing" : `the database lacks ${items.join(" and ")}`}. Run \`hot-updater db generate\`, apply it with ${applyTables}, then migrate again.`,
    );
    this.name = "HotUpdaterSchemaTablesMissingError";
  }
}

/**
 * `hot-updater db migrate` for an ORM that applies the DDL itself (Drizzle,
 * Prisma). Before it writes the settings rows it refuses a v0 database or one
 * a newer release migrated, checks that every table and index the target
 * declares exists, and sets the collations the ORM cannot declare on the
 * columns that lack them. The `createMigrator` of an adapter whose ORM
 * creates the tables returns it, as the Drizzle and Prisma adapters' do.
 */
export const createSettingsMigrator = (options: {
  readonly adapterName: string;
  readonly executor: SqlExecutor;
  /** The tables the ORM applies, which must exist before the settings move. */
  readonly schema: ResolvedSchema;
  readonly settings: SchemaSettings;
  /** The settings whose versions only move forward; `ToolingTarget.ordered`. */
  readonly ordered?: readonly string[];
  /** The command that applies the generated schema, for the error when tables are missing. */
  readonly applyTables: string;
  /**
   * The columns whose collation the ORM cannot declare, which `db migrate`
   * sets where the database lacks it. The settings table is left as it is:
   * it is only read by key, and the migrator has already read it, so
   * altering it would invalidate PostgreSQL's cached plan for that read.
   */
  readonly collate?: (column: SqlColumnShape) => boolean;
}): Migrator => {
  const read = () => readStoredSettings(options.executor);
  const getVersion = async () => storedSchemaVersion(await read());
  const { executor } = options;

  const makeResult = async (
    migrate: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    const stored = (await read()) ?? new Map<string, unknown>();
    refuseV0Database(options.adapterName, stored);
    refuseNewerSchema(
      options.adapterName,
      stored,
      options.settings,
      options.ordered,
    );
    const shapes = targetShapes(executor.dialect, options.schema);
    const missing = missingSqlSchema(
      shapes,
      await readSqlSchemaState(executor),
    );
    // A column added to a table a released schema created, and that table's
    // missing indexes, are added here when the ORM's migration left them
    // out: a migration file written for a database an earlier release
    // created leaves out every statement on the tables it already has.
    const lateTables = new Set(missing.columns.map(({ table }) => table));
    const lateIndexes = missing.indexes.filter(({ table }) =>
      lateTables.has(table),
    );
    const blocking = missing.indexes.filter(
      ({ table }) => !lateTables.has(table),
    );
    if (missing.tables.length > 0 || blocking.length > 0) {
      throw new HotUpdaterSchemaTablesMissingError(
        options.adapterName,
        { tables: missing.tables, columns: [], indexes: blocking },
        options.applyTables,
      );
    }
    const quote = (name: string) => quoteSql(executor.dialect, name);
    const lateSchema = [
      ...addColumnStatements(executor.dialect, missing.columns),
      ...lateIndexes.map(({ table, index: name }) => {
        const index = shapes
          .find((shape) => shape.name === table)!
          .indexes.find(
            (candidate) =>
              candidate.kind === "index" && candidate.name === name,
          )!;
        return index.kind === "index"
          ? `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(table)} (${index.columns.map(quote).join(", ")})`
          : "";
      }),
    ];
    const collations =
      options.collate === undefined
        ? { statements: [], columns: 0 }
        : await collationStatements(
            executor,
            shapes.filter((shape) => shape.name !== SETTINGS_TABLE.name),
            options.collate,
          );
    const changed =
      migrate.updateSettings === false
        ? []
        : Object.entries(options.settings).filter(
            ([key, value]) => stored.get(key) !== value,
          );
    if (
      lateSchema.length === 0 &&
      collations.statements.length === 0 &&
      changed.length === 0
    ) {
      return getEmptyMigrationResult();
    }
    const statements = [
      ...lateSchema,
      ...collations.statements,
      ...(changed.length === 0
        ? []
        : settingsStatements(executor.dialect, options.settings)),
    ];
    const operations: MigrationOperation[] = [
      ...missing.columns.map(({ table, column }) => ({
        type: "custom" as const,
        description: `Add column: ${column.name} to ${table}`,
      })),
      ...lateIndexes.map(({ table, index }) => ({
        type: "custom" as const,
        description: `Create index: ${index} on ${table}`,
      })),
      ...(collations.columns === 0
        ? []
        : [
            {
              type: "custom" as const,
              description: `Set the byte-order collation the ORM cannot declare on ${collations.columns} column${collations.columns === 1 ? "" : "s"} of ${collations.statements.length} table${collations.statements.length === 1 ? "" : "s"}`,
            },
          ]),
      ...(changed.length === 0 ? [] : [settingsOperation(stored, changed)]),
    ];
    return {
      operations,
      getSQL: () => statements.map((statement) => `${statement};`).join("\n\n"),
      execute: async () => {
        for (const sql of statements) {
          await executor.execute({ sql, params: [] });
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

/** The settings rows a migration changes, each with its stored value. */
export const settingsOperation = (
  stored: ReadonlyMap<string, unknown>,
  changed: readonly (readonly [string, string])[],
): MigrationOperation => ({
  type: "custom",
  description: `Record ${changed
    .map(([key, value]) => {
      const found = stored.get(key);
      return typeof found === "string"
        ? `${key} ${found} → ${value}`
        : `${key} ${value}`;
    })
    .join(", ")}`,
});
