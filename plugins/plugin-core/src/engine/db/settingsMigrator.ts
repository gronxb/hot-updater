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

/** The settings whose versions only move forward when a `ToolingTarget` names none. */
export const DEFAULT_ORDERED_SETTINGS: readonly string[] = [
  ENGINE_SCHEMA_KEY,
  "schema.core",
];

/**
 * Refuses a database that recorded a newer version of an `ordered` setting
 * than this release migrates to: writing this release's would move the
 * schema back, and every server of the newer release would answer 503.
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
  if (newer.length === 0) return;
  const core = newer.find(({ key }) => key === "schema.core");
  const by =
    core === undefined ? "a newer Hot Updater" : `Hot Updater ${core.found}`;
  throw new Error(
    `${adapterName}: the database was migrated by ${by} (${newer.map(({ key, found, expected }) => `${key} "${found}", this CLI's "${expected}"`).join("; ")}). Upgrade hot-updater ${core === undefined ? "and its plugins to that version" : `to ${core.found} or later`}; nothing was written.`,
  );
};

/**
 * The tables or indexes an ORM has yet to apply, found before `db migrate`
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
    if (missing.tables.length > 0 || missing.indexes.length > 0) {
      throw new HotUpdaterSchemaTablesMissingError(
        options.adapterName,
        missing,
        options.applyTables,
      );
    }
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
    if (collations.statements.length === 0 && changed.length === 0) {
      return getEmptyMigrationResult();
    }
    const statements = [
      ...collations.statements,
      ...(changed.length === 0
        ? []
        : settingsStatements(executor.dialect, options.settings)),
    ];
    const operations: MigrationOperation[] = [
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
