import {
  getHotUpdaterSchemaVersion,
  hotUpdaterSchema,
  schemaIndexAppliesToProvider,
  type HotUpdaterColumnSchema,
  type HotUpdaterColumnType,
  type HotUpdaterDefault,
  type HotUpdaterRelationSchema,
  type HotUpdaterTableSchema,
  type HotUpdaterVersionedSchema,
} from "./hotUpdaterSchema";
import type { ORMProvider, ORMSQLProvider, SchemaGenerator } from "./types";
import { getSQLProvider } from "./types";

const literal = (value: string): string => JSON.stringify(value);

const toPascalCase = (value: string): string =>
  value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");

const prismaDb = (type: HotUpdaterColumnType, provider: ORMProvider) => {
  if (provider === "postgresql") {
    if (type === "uuid") return " @db.Uuid";
    if (type.startsWith("varchar")) return " @db.VarChar(255)";
  }
  if (provider === "mysql") {
    if (type === "uuid") return " @db.Char(36)";
    if (type.startsWith("varchar")) return " @db.VarChar(255)";
  }
  return "";
};

const prismaType = (
  column: HotUpdaterColumnSchema,
  provider: ORMProvider,
): string => {
  const base = (() => {
    if (column.type === "bool") return "Boolean";
    if (column.type === "integer") return "Int";
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
): readonly HotUpdaterRelationSchema[] =>
  schema.tables.flatMap((sourceTable) =>
    (sourceTable.relations ?? []).filter(
      (relation) => relation.referencedTable === table.ormName,
    ),
  );

const prismaRelationFields = (
  table: HotUpdaterTableSchema,
  schema: HotUpdaterVersionedSchema,
): string[] => {
  const lines = relationTargetFields(table, schema).map(
    (relation) =>
      `${relation.fieldName} ${relation.referencedTable === table.ormName ? "bundle_patches" : relation.referencedTable}[] @relation(${literal(relation.relationName)})`,
  );

  for (const relation of table.relations ?? []) {
    const targetType = toPascalCase(relation.referencedTable);
    lines.push(
      `${relation.targetFieldName} ${targetType === "Bundles" ? "bundles" : relation.referencedTable} @relation(${literal(relation.relationName)}, fields: [${relation.columns.join(", ")}], references: [${relation.referencedColumns.join(", ")}], onUpdate: Restrict, onDelete: Cascade)`,
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
        `@@index([${index.columns.join(", ")}], map: ${literal(index.name)})`,
    );

export const generatePrismaSchema = (
  provider: ORMProvider,
  schema: HotUpdaterVersionedSchema = hotUpdaterSchema,
) =>
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
    .join("\n\n");

const drizzleImportSource = (provider: ORMSQLProvider) =>
  provider === "sqlite"
    ? "drizzle-orm/sqlite-core"
    : provider === "mysql"
      ? "drizzle-orm/mysql-core"
      : "drizzle-orm/pg-core";

const drizzleTableFn = (provider: ORMSQLProvider) =>
  provider === "sqlite"
    ? "sqliteTable"
    : provider === "mysql"
      ? "mysqlTable"
      : "pgTable";

const drizzleColumnFn = (
  column: HotUpdaterColumnSchema,
  provider: ORMSQLProvider,
): { code: string; imports: readonly string[] } => {
  if (provider === "sqlite") {
    if (column.type === "bool") {
      return {
        code: `integer(${literal(column.ormName)}, { mode: "boolean" })`,
        imports: ["integer"],
      };
    }
    if (column.type === "integer") {
      return {
        code: `integer(${literal(column.ormName)})`,
        imports: ["integer"],
      };
    }
    if (column.type === "json") {
      return {
        code: `blob(${literal(column.ormName)}, { mode: "json" })`,
        imports: ["blob"],
      };
    }
    return { code: `text(${literal(column.ormName)})`, imports: ["text"] };
  }

  if (provider === "mysql") {
    if (column.type === "uuid") {
      return {
        code: `char(${literal(column.ormName)}, { length: 36 })`,
        imports: ["char"],
      };
    }
    if (column.type === "bool") {
      return {
        code: `boolean(${literal(column.ormName)})`,
        imports: ["boolean"],
      };
    }
    if (column.type === "integer") {
      return { code: `int(${literal(column.ormName)})`, imports: ["int"] };
    }
    if (column.type === "json") {
      return { code: `json(${literal(column.ormName)})`, imports: ["json"] };
    }
    if (column.type.startsWith("varchar")) {
      return {
        code: `varchar(${literal(column.ormName)}, { length: 255 })`,
        imports: ["varchar"],
      };
    }
    return { code: `text(${literal(column.ormName)})`, imports: ["text"] };
  }

  if (column.type === "uuid") {
    return { code: `uuid(${literal(column.ormName)})`, imports: ["uuid"] };
  }
  if (column.type === "bool") {
    return {
      code: `boolean(${literal(column.ormName)})`,
      imports: ["boolean"],
    };
  }
  if (column.type === "integer") {
    return {
      code: `integer(${literal(column.ormName)})`,
      imports: ["integer"],
    };
  }
  if (column.type === "json") {
    return { code: `json(${literal(column.ormName)})`, imports: ["json"] };
  }
  if (column.type.startsWith("varchar")) {
    return {
      code: `varchar(${literal(column.ormName)}, { length: 255 })`,
      imports: ["varchar"],
    };
  }
  return { code: `text(${literal(column.ormName)})`, imports: ["text"] };
};

const drizzleDefault = (value: HotUpdaterDefault | undefined): string => {
  if (!value) return "";
  if (value.type === "json") return ".default({})";
  return `.default(${JSON.stringify(value.value)})`;
};

const drizzleTable = (
  table: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
  imports: Set<string>,
): string => {
  const columns = table.columns.map((column) => {
    const type = drizzleColumnFn(column, provider);
    for (const item of type.imports) imports.add(item);
    const chain = [
      type.code,
      column.primaryKey ? "primaryKey()" : undefined,
      column.nullable ? undefined : "notNull()",
      drizzleDefault(column.default).slice(1) || undefined,
    ].filter(Boolean);
    return `  ${column.ormName}: ${chain.join(".")}`;
  });

  const callbacks: string[] = [];
  for (const foreignKey of table.foreignKeys ?? []) {
    imports.add("foreignKey");
    callbacks.push(`foreignKey({
    columns: [table.${foreignKey.columns.join(", table.")}],
    foreignColumns: [${foreignKey.referencedTable}.${foreignKey.referencedColumns.join(
      `, ${foreignKey.referencedTable}.`,
    )}],
    name: ${literal(foreignKey.name)}
  }).onUpdate(${literal(foreignKey.onUpdate)}).onDelete(${literal(
    foreignKey.onDelete,
  )})`);
  }
  for (const index of (table.indexes ?? []).filter((item) =>
    schemaIndexAppliesToProvider(item, provider),
  )) {
    imports.add("index");
    callbacks.push(
      `index(${literal(index.name)}).on(${index.columns
        .map((column) => `table.${column}`)
        .join(", ")})`,
    );
  }

  const args = [
    literal(table.ormName),
    `{\n${columns.join(",\n")}\n}`,
    callbacks.length > 0
      ? `(table) => [\n${callbacks.map((line) => `  ${line}`).join(",\n")}\n]`
      : undefined,
  ].filter(Boolean);

  return `export const ${table.ormName} = ${drizzleTableFn(provider)}(${args.join(
    ", ",
  )})`;
};

const drizzleRelations = (table: HotUpdaterTableSchema): string | undefined => {
  if (!table.relations || table.relations.length === 0) return undefined;
  const lines = table.relations.map(
    (
      relation,
    ) => `  ${relation.targetFieldName}: one(${relation.referencedTable}, {
    relationName: ${literal(relation.relationName)},
    fields: [${relation.columns.map((column) => `${table.ormName}.${column}`).join(", ")}],
    references: [${relation.referencedColumns
      .map((column) => `${relation.referencedTable}.${column}`)
      .join(", ")}]
  })`,
  );
  return `export const ${table.ormName}Relations = relations(${table.ormName}, ({ one }) => ({
${lines.join(",\n")}
}))`;
};

export const generateDrizzleSchema = (
  provider: ORMSQLProvider,
  schema: HotUpdaterVersionedSchema = hotUpdaterSchema,
) => {
  const imports = new Set<string>([drizzleTableFn(provider)]);
  const body: string[] = [];

  for (const table of schema.tables) {
    body.push(drizzleTable(table, provider, imports));
    const relations = drizzleRelations(table);
    if (relations) body.push(relations);
  }

  if (body.some((block) => block.includes("relations("))) {
    body.unshift('import { relations } from "drizzle-orm"');
  }

  const importLine = `import { ${Array.from(imports)
    .sort()
    .join(", ")} } from "${drizzleImportSource(provider)}"`;

  return [importLine, ...body].join("\n\n");
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

  const sqlProvider = getSQLProvider(provider);
  if (adapterName === "drizzle" && sqlProvider) {
    return {
      ...fallback,
      code: generateDrizzleSchema(sqlProvider, schema),
    };
  }

  return fallback;
};
