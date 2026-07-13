import {
  HOT_UPDATER_SETTINGS_TABLE,
  type HotUpdaterCheckSchema,
  type HotUpdaterColumnSchema,
  type HotUpdaterColumnType,
  type HotUpdaterForeignKeySchema,
  type HotUpdaterTableSchema,
} from "../../schema/types";
import type {
  MigrationOperation,
  ORMSQLProvider,
  RelationMode,
} from "../types";
import {
  getSchemaColumn,
  hotUpdaterDataTables,
  hotUpdaterSchema,
  schemaIndexAppliesToProvider,
} from "./registry";

export const hotUpdaterCreateTableOperations: MigrationOperation[] =
  hotUpdaterDataTables.map((table) => ({
    type: "create-table",
    value: {
      ormName: table.ormName,
      columns: Object.fromEntries(
        table.columns.map((column) => [
          column.ormName,
          { ormName: column.ormName, type: column.type },
        ]),
      ),
    },
  }));

export const getSqlType = (
  type: HotUpdaterColumnType,
  provider: ORMSQLProvider,
): string => {
  if (provider === "sqlite") {
    if (type === "bool" || type === "integer") return "integer";
    return "text";
  }
  if (provider === "mysql") {
    if (type === "uuid") return "char(36)";
    if (type === "bool") return "boolean";
    if (type === "integer") return "integer";
    if (type === "json") return "json";
    if (type.startsWith("varchar")) return type;
    return "text";
  }
  if (type === "uuid") return "uuid";
  if (type === "bool") return "boolean";
  if (type === "integer") return "integer";
  if (type === "json") return "json";
  if (type.startsWith("varchar")) return type;
  return "text";
};

const sqlStringLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const sqlDefaultClause = (
  column: HotUpdaterColumnSchema,
  provider: ORMSQLProvider,
): string => {
  const value = column.default;
  if (!value) return "";
  if (
    provider === "mysql" &&
    (column.type === "json" || column.type === "string")
  ) {
    return "";
  }
  if (value.type === "json") {
    const json = sqlStringLiteral(JSON.stringify(value.value));
    return provider === "postgresql" || provider === "cockroachdb"
      ? ` default ${json}::json`
      : ` default ${json}`;
  }
  if (typeof value.value === "string") {
    return ` default ${sqlStringLiteral(value.value)}`;
  }
  return ` default ${String(value.value)}`;
};

const sqlColumnName = (
  table: HotUpdaterTableSchema,
  column: HotUpdaterColumnSchema,
  provider: ORMSQLProvider,
): string =>
  table.ormName === HOT_UPDATER_SETTINGS_TABLE &&
  column.ormName === "key" &&
  provider === "mysql"
    ? "`key`"
    : column.ormName;

export const sqlColumnDefinition = (
  table: HotUpdaterTableSchema,
  column: HotUpdaterColumnSchema,
  provider: ORMSQLProvider,
): string => {
  const constraints = [
    column.primaryKey ? "primary key" : undefined,
    column.nullable ? undefined : "not null",
  ].filter(Boolean);
  return (
    [
      sqlColumnName(table, column, provider),
      getSqlType(column.type, provider),
      ...constraints,
    ].join(" ") + sqlDefaultClause(column, provider)
  );
};

const sqlIndexColumn = (
  table: HotUpdaterTableSchema,
  columnName: string,
  provider: ORMSQLProvider,
): string => {
  const column = getSchemaColumn(table, columnName);
  return provider === "mysql" && column.type === "string"
    ? `${columnName}(255)`
    : columnName;
};

export const createIndexSql = (
  table: HotUpdaterTableSchema,
  index: {
    readonly name: string;
    readonly columns: readonly string[];
    readonly unique?: true;
  },
  provider: ORMSQLProvider,
): string =>
  `create ${index.unique ? "unique " : ""}index ${index.name} on ${table.ormName}(${index.columns
    .map((column) => sqlIndexColumn(table, column, provider))
    .join(", ")})`;

export const createForeignKeySql = (
  table: HotUpdaterTableSchema,
  foreignKey: HotUpdaterForeignKeySchema,
): string =>
  `alter table ${table.ormName} add constraint ${foreignKey.name} foreign key (${foreignKey.columns.join(", ")}) references ${foreignKey.referencedTable}(${foreignKey.referencedColumns.join(", ")}) on update ${foreignKey.onUpdate} on delete ${foreignKey.onDelete}`;

export const createCheckSql = (
  table: HotUpdaterTableSchema,
  check: HotUpdaterCheckSchema,
): string =>
  `alter table ${table.ormName} add constraint ${check.name} check (${check.expression})`;

const inlineSqlChecks = (
  table: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
): string[] =>
  provider === "sqlite"
    ? (table.checks ?? [])
        .filter((check) => check.sqliteInline)
        .map((check) => `constraint ${check.name} check (${check.expression})`)
    : [];

export const createTableStatement = (
  table: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): string => {
  const lines = [
    ...table.columns.map((column) =>
      sqlColumnDefinition(table, column, provider),
    ),
    ...inlineSqlChecks(table, provider),
    ...(provider === "sqlite" && relationMode === "foreign-keys"
      ? (table.foreignKeys ?? []).map(
          (foreignKey) =>
            `constraint ${foreignKey.name} foreign key (${foreignKey.columns.join(", ")}) references ${foreignKey.referencedTable}(${foreignKey.referencedColumns.join(", ")}) on update ${foreignKey.onUpdate} on delete ${foreignKey.onDelete}`,
        )
      : []),
  ];
  return `create table if not exists ${table.ormName} (\n${lines.join(",\n")}\n)`;
};

export const createForeignKeySqlStatements = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] => {
  if (relationMode !== "foreign-keys" || provider === "sqlite") return [];
  return hotUpdaterSchema.tables.flatMap((table) =>
    (table.foreignKeys ?? []).map((foreignKey) =>
      createForeignKeySql(table, foreignKey),
    ),
  );
};

export const createTableSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] => [
  ...hotUpdaterSchema.tables.map((table) =>
    createTableStatement(table, provider, relationMode),
  ),
  ...hotUpdaterSchema.tables.flatMap((table) =>
    (table.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, provider))
      .map((index) => createIndexSql(table, index, provider)),
  ),
  ...(provider === "sqlite"
    ? []
    : hotUpdaterSchema.tables.flatMap((table) =>
        (table.checks ?? []).map((check) => createCheckSql(table, check)),
      )),
  ...createForeignKeySqlStatements(provider, relationMode),
];
