import {
  type HotUpdaterColumnSchema,
  type HotUpdaterColumnType,
  type HotUpdaterRelationSchema,
  type HotUpdaterTableSchema,
  type HotUpdaterVersionedSchema,
} from "../schema/types";
import { getInsightsCollationSql } from "./schema/insightsCollation";
import {
  getHotUpdaterSchemaVersion,
  hotUpdaterSchema,
  schemaIndexAppliesToProvider,
} from "./schema/registry";
import type { ORMProvider, SchemaGenerator } from "./types";
import { getSQLProvider } from "./types";

const literal = (value: string): string => JSON.stringify(value);

const varcharLength = (type: HotUpdaterColumnType): number =>
  Number(type.slice("varchar(".length, -1));

const toPascalCase = (value: string): string =>
  value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");

const prismaDb = (type: HotUpdaterColumnType, provider: ORMProvider) => {
  if (provider === "cockroachdb" && type === "uuid") return " @db.Uuid";
  if (provider === "postgresql") {
    if (type === "uuid") return " @db.Uuid";
    if (type.startsWith("varchar")) {
      return ` @db.VarChar(${varcharLength(type)})`;
    }
  }
  if (provider === "mysql") {
    if (type === "uuid") return " @db.Char(36)";
    if (type === "large-string") return " @db.MediumText";
    if (type.startsWith("varchar")) {
      return ` @db.VarChar(${varcharLength(type)})`;
    }
  }
  return "";
};

const prismaType = (
  column: HotUpdaterColumnSchema,
  provider: ORMProvider,
): string => {
  const base = (() => {
    if (column.type === "bool") return "Boolean";
    if (column.type === "float") return "Float";
    if (column.type === "integer") return "Int";
    if (column.type === "bigint") return "BigInt";
    if (column.type === "json") return "Json";
    return "String";
  })();
  return `${base}${column.nullable ? "?" : ""}${prismaDb(
    column.type,
    provider,
  )}`;
};

const prismaDefault = (
  column: HotUpdaterColumnSchema,
  provider: ORMProvider,
): string => {
  if (!column.default) return "";
  if (provider === "sqlite" && column.type === "json") return "";
  if (column.default.type === "json") {
    return ` @default(${literal(JSON.stringify(column.default.value))})`;
  }
  return ` @default(${JSON.stringify(column.default.value)})`;
};

const prismaField = (
  column: HotUpdaterColumnSchema,
  provider: ORMProvider,
): string =>
  [
    column.ormName,
    prismaType(column, provider),
    column.primaryKey ? "@id" : undefined,
    prismaDefault(column, provider).trim() || undefined,
  ]
    .filter(Boolean)
    .join(" ");

const relationTargetFields = (
  table: HotUpdaterTableSchema,
  schema: HotUpdaterVersionedSchema,
): readonly {
  readonly relation: HotUpdaterRelationSchema;
  readonly sourceTable: HotUpdaterTableSchema;
}[] =>
  schema.tables.flatMap((sourceTable) =>
    (sourceTable.relations ?? [])
      .filter((relation) => relation.referencedTable === table.ormName)
      .map((relation) => ({ relation, sourceTable })),
  );

const prismaRelationFields = (
  table: HotUpdaterTableSchema,
  schema: HotUpdaterVersionedSchema,
): string[] => {
  const lines = relationTargetFields(table, schema).map(
    ({ relation, sourceTable }) =>
      `${relation.fieldName} ${sourceTable.ormName}[] @relation(${literal(relation.relationName)})`,
  );

  for (const relation of table.relations ?? []) {
    const targetType = toPascalCase(relation.referencedTable);
    const foreignKey = table.foreignKeys?.find(
      (item) =>
        item.referencedTable === relation.referencedTable &&
        item.columns.join("\0") === relation.columns.join("\0") &&
        item.referencedColumns.join("\0") ===
          relation.referencedColumns.join("\0"),
    );
    if (!foreignKey) {
      throw new Error(
        `Missing foreign key metadata for relation ${table.ormName}.${relation.name}`,
      );
    }
    const optional = relation.columns.some(
      (columnName) =>
        table.columns.find(({ ormName }) => ormName === columnName)?.nullable,
    );
    const onDelete =
      foreignKey.onDelete === "cascade"
        ? "Cascade"
        : foreignKey.onDelete === "set null"
          ? "SetNull"
          : "Restrict";
    lines.push(
      `${relation.targetFieldName} ${targetType === "Bundles" ? "bundles" : relation.referencedTable}${optional ? "?" : ""} @relation(${literal(relation.relationName)}, fields: [${relation.columns.join(", ")}], references: [${relation.referencedColumns.join(", ")}], onUpdate: Restrict, onDelete: ${onDelete})`,
    );
  }

  return lines;
};

const prismaIndexes = (
  table: HotUpdaterTableSchema,
  provider: ORMProvider,
): string[] =>
  (table.indexes ?? [])
    .filter((index) => schemaIndexAppliesToProvider(index, provider))
    .map(
      (index) =>
        `@@${index.unique ? "unique" : "index"}([${index.columns.join(", ")}], map: ${literal(index.name)})`,
    );

export const generatePrismaSchema = (
  provider: ORMProvider,
  schema: HotUpdaterVersionedSchema = hotUpdaterSchema,
) => {
  const sqlProvider = getSQLProvider(provider);
  const collationSql = sqlProvider ? getInsightsCollationSql(sqlProvider) : [];
  const header =
    collationSql.length === 0
      ? ""
      : [
          "// Apply these statements in the initial Prisma SQL migration to preserve exact Insights identities and cursors:",
          ...collationSql.map((statement) => `// ${statement};`),
          "",
        ].join("\n");
  return (
    header +
    schema.tables
      .map((table) => {
        const lines = [
          ...table.columns.map((column) => prismaField(column, provider)),
          ...prismaRelationFields(table, schema),
          ...prismaIndexes(table, provider),
        ];
        return `model ${table.ormName} {\n${lines
          .map((line) => `  ${line}`)
          .join("\n")}\n}`;
      })
      .join("\n\n")
  );
};

export const generateSchemaFromHotUpdaterSchema = (
  adapterName: string,
  provider: ORMProvider | undefined,
  version: string | "latest",
  fallback: ReturnType<SchemaGenerator>,
): ReturnType<SchemaGenerator> => {
  const schema =
    version === "latest"
      ? hotUpdaterSchema
      : getHotUpdaterSchemaVersion(version);

  if (adapterName === "prisma" && provider) {
    return {
      ...fallback,
      code: generatePrismaSchema(provider, schema),
    };
  }

  return fallback;
};
