import {
  SETTINGS_TABLE,
  quoteSql,
  sqlTableShapes,
  type SqlColumnShape,
  type SqlTableShape,
} from "@hot-updater/plugin-core";
import type { ResolvedSchema } from "@hot-updater/plugin-core";

export type PrismaProvider = "postgresql" | "mysql" | "sqlite";

interface PrismaColumn {
  readonly scalar: string;
  /** The native type attribute, such as `@db.VarChar(64)`. */
  readonly native?: string;
  /** Whether `db migrate` sets the column's collation, which Prisma cannot declare. */
  readonly collate?: true;
}

const SCALARS: Readonly<Record<string, string>> = {
  TEXT: "String",
  INTEGER: "BigInt",
  REAL: "Float",
  bigint: "BigInt",
  "double precision": "Float",
  double: "Float",
  boolean: "Boolean",
  jsonb: "Json",
  json: "Json",
};

/**
 * A column's Prisma type from the DDL type the shared SQL schema gives it.
 * MySQL's ASCII keys become `VarBinary`: the same bytes and order as
 * `ascii_bin`, within InnoDB's key limit without a character set.
 */
const prismaColumn = (
  provider: PrismaProvider,
  { type }: SqlColumnShape,
): PrismaColumn => {
  const length = /^varchar\((\d+)\)/u.exec(type)?.[1];
  if (provider === "mysql" && type.includes("CHARACTER SET")) {
    if (type.includes("CHARACTER SET ascii") && length) {
      return { scalar: "Bytes", native: `@db.VarBinary(${length})` };
    }
    return {
      scalar: "String",
      native: length ? `@db.VarChar(${length})` : "@db.LongText",
      collate: true,
    };
  }
  if (provider === "postgresql" && type.includes("COLLATE")) {
    return {
      scalar: "String",
      ...(length ? { native: `@db.VarChar(${length})` } : {}),
      collate: true,
    };
  }
  return { scalar: SCALARS[type] ?? "String" };
};

/** Prisma fields start with a letter: `_v` becomes `hu_v`, mapped back to `_v`. */
const fieldName = (column: string) =>
  column.startsWith("_") ? `hu${column}` : column;

const list = (columns: readonly string[]) =>
  `[${columns.map(fieldName).join(", ")}]`;

const flatten = (shapes: readonly SqlTableShape[]): SqlTableShape[] =>
  shapes.flatMap((shape) => [
    shape,
    ...flatten(
      shape.indexes.flatMap((index) =>
        index.kind === "table" ? [index.table] : [],
      ),
    ),
  ]);

const shapesOf = (provider: PrismaProvider, schema: ResolvedSchema) =>
  flatten(sqlTableShapes(provider, [...schema.tables, SETTINGS_TABLE]));

const renderField = (provider: PrismaProvider, column: SqlColumnShape) => {
  const { scalar, native } = prismaColumn(provider, column);
  const name = fieldName(column.name);
  return [
    `${name} ${scalar}${column.notNull ? "" : "?"}`,
    ...(native === undefined ? [] : [native]),
    ...(column.default === undefined ? [] : [`@default(${column.default})`]),
    ...(name === column.name ? [] : [`@map(${JSON.stringify(column.name)})`]),
  ].join(" ");
};

/**
 * Hot Updater's tables as Prisma models, for `prisma db push` or
 * `prisma migrate`: keys, indexes, index tables, and the settings table.
 * The engine keeps references itself, so the models have no relations.
 */
export const generatePrismaEngineSchema = (
  provider: PrismaProvider,
  schema: ResolvedSchema,
): string =>
  shapesOf(provider, schema)
    .map((shape) => {
      const lines = [
        ...shape.columns.map((column) => renderField(provider, column)),
        `@@id(${list(shape.key)})`,
        ...shape.indexes.flatMap((index) =>
          index.kind === "index"
            ? [
                `@@${index.unique ? "unique" : "index"}(${list(index.columns)}, map: ${JSON.stringify(index.name)})`,
              ]
            : [],
        ),
      ];
      return `model ${shape.name} {\n${lines.map((line) => `  ${line}`).join("\n")}\n}`;
    })
    .join("\n\n");

/** A table's columns whose collation Prisma cannot declare, and the statement that sets them. */
export interface PrismaCollationFixup {
  readonly table: string;
  /** Each column and the collation `statement` gives it. */
  readonly columns: readonly {
    readonly name: string;
    readonly collation: string;
  }[];
  readonly statement: string;
}

/**
 * The collations Prisma cannot declare, which `hot-updater db migrate` sets
 * after Prisma created the tables: `COLLATE "C"` on PostgreSQL and binary
 * UTF-8 on MySQL, so strings compare by their bytes as the engine expects.
 * The settings table is only read by key, and the migrator has already read
 * it: altering it would invalidate PostgreSQL's cached plan for that read.
 */
export const prismaCollationFixups = (
  provider: PrismaProvider,
  schema: ResolvedSchema,
): PrismaCollationFixup[] => {
  if (provider !== "postgresql" && provider !== "mysql") return [];
  const quote = (name: string) => quoteSql(provider, name);
  const tables = shapesOf(provider, schema).filter(
    (shape) => shape.name !== SETTINGS_TABLE.name,
  );
  return tables.flatMap((shape) => {
    const columns = shape.columns.filter(
      (column) => prismaColumn(provider, column).collate,
    );
    if (columns.length === 0) return [];
    const changes = columns.map((column) =>
      provider === "postgresql"
        ? `ALTER COLUMN ${quote(column.name)} TYPE ${column.type}`
        : `MODIFY ${quote(column.name)} ${column.type}${column.notNull ? " NOT NULL" : " NULL"}`,
    );
    return [
      {
        table: shape.name,
        columns: columns.map((column) => ({
          name: column.name,
          collation: /COLLATE "?([\w-]+)"?/u.exec(column.type)![1]!,
        })),
        statement: `ALTER TABLE ${quote(shape.name)} ${changes.join(", ")}`,
      },
    ];
  });
};

/**
 * The fixups whose tables exist with a column of another collation: a table
 * Prisma created after `db migrate` last ran, such as one a release adds that
 * its prerelease lacked, so `db migrate` sets it although the settings match.
 * A missing table needs none until Prisma creates it.
 */
export const pendingPrismaCollationFixups = async (
  provider: PrismaProvider,
  fixups: readonly PrismaCollationFixup[],
  read: (sql: string) => Promise<readonly Record<string, unknown>[]>,
): Promise<string[]> => {
  if (fixups.length === 0) return [];
  const rows = await read(
    provider === "postgresql"
      ? "SELECT table_name AS t, column_name AS c, collation_name AS k FROM information_schema.columns WHERE table_schema = current_schema()"
      : "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLLATION_NAME AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()",
  );
  // MySQL folds table names with lower_case_table_names.
  const fold = (name: unknown) =>
    provider === "mysql" ? String(name).toLowerCase() : String(name);
  const found = new Map(
    rows.map((row) => [JSON.stringify([fold(row.t), String(row.c)]), row.k]),
  );
  return fixups
    .filter(({ table, columns }) =>
      columns.some(({ name, collation }) => {
        const key = JSON.stringify([fold(table), name]);
        return found.has(key) && found.get(key) !== collation;
      }),
    )
    .map(({ statement }) => statement);
};
