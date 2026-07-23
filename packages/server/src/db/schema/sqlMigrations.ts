import { hotUpdaterSchemaVersions } from "../../schema";
import type { ORMSQLProvider, RelationMode } from "../types";
import { schemaIndexAppliesToProvider } from "./registry";
import {
  assertExistingSchemaMetadataIsPreserved,
  assertV036MigrationSchemaDriftIsAllowlisted,
} from "./schemaDriftValidator";
import {
  createCheckSql,
  createForeignKeySql,
  createIndexSql,
  createTableStatement,
  sqlColumnDefinition,
} from "./sql";
import { createV036MigrationSql } from "./sqlMigrationsV036";
import { createV038MigrationSql } from "./sqlMigrationsV038";

const getSchemaVersionIndex = (version: string): number =>
  hotUpdaterSchemaVersions.findIndex((schema) => schema.version === version);

const createAddedTableSql = (
  table: (typeof hotUpdaterSchemaVersions)[number]["tables"][number],
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): readonly string[] => [
  createTableStatement(table, provider, relationMode),
  ...(table.indexes ?? [])
    .filter((index) => schemaIndexAppliesToProvider(index, provider))
    .map((index) => createIndexSql(table, index, provider)),
  ...(provider === "sqlite"
    ? []
    : (table.checks ?? []).map((check) => createCheckSql(table, check))),
  ...(relationMode === "foreign-keys" && provider !== "sqlite"
    ? (table.foreignKeys ?? []).map((foreignKey) =>
        createForeignKeySql(table, foreignKey),
      )
    : []),
];

const createChangedTableSql = (
  previous: (typeof hotUpdaterSchemaVersions)[number]["tables"][number],
  next: (typeof hotUpdaterSchemaVersions)[number]["tables"][number],
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): readonly string[] => {
  assertExistingSchemaMetadataIsPreserved(previous, next, provider);
  const previousColumns = new Set(
    previous.columns.map((column) => column.ormName),
  );
  const previousIndexes = new Set(
    (previous.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, provider))
      .map((index) => index.name),
  );
  const previousChecks = new Set(
    (previous.checks ?? []).map((check) => check.name),
  );
  const previousForeignKeys = new Set(
    (previous.foreignKeys ?? []).map((foreignKey) => foreignKey.name),
  );
  return [
    ...next.columns
      .filter((column) => !previousColumns.has(column.ormName))
      .map(
        (column) =>
          `alter table ${next.ormName} add column ${sqlColumnDefinition(next, column, provider)}`,
      ),
    ...(next.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, provider))
      .filter((index) => !previousIndexes.has(index.name))
      .map((index) => createIndexSql(next, index, provider)),
    ...(provider === "sqlite"
      ? []
      : (next.checks ?? [])
          .filter((check) => !previousChecks.has(check.name))
          .map((check) => createCheckSql(next, check))),
    ...(relationMode === "foreign-keys" && provider !== "sqlite"
      ? (next.foreignKeys ?? [])
          .filter((foreignKey) => !previousForeignKeys.has(foreignKey.name))
          .map((foreignKey) => createForeignKeySql(next, foreignKey))
      : []),
  ];
};

export const createSchemaMigrationSql = (
  fromVersion: string,
  toVersion: string,
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] => {
  const fromIndex = getSchemaVersionIndex(fromVersion);
  const toIndex = getSchemaVersionIndex(toVersion);
  if (fromIndex === -1)
    throw new Error(`Unsupported Hot Updater schema version: ${fromVersion}`);
  if (toIndex === -1)
    throw new Error(`Unsupported Hot Updater schema version: ${toVersion}`);
  if (fromIndex > toIndex)
    throw new Error(`Cannot migrate Hot Updater schema down to ${toVersion}.`);

  const statements: string[] = [];
  for (let index = fromIndex + 1; index <= toIndex; index += 1) {
    const previous = hotUpdaterSchemaVersions[index - 1];
    const next = hotUpdaterSchemaVersions[index];
    if (previous === undefined || next === undefined) {
      throw new Error("Hot Updater schema version registry is incomplete.");
    }
    if (previous.version === "0.31.0" && next.version === "0.36.0") {
      assertV036MigrationSchemaDriftIsAllowlisted(previous, next, provider);
      statements.push(...createV036MigrationSql(provider, relationMode));
      continue;
    }
    if (previous.version === "0.37.0" && next.version === "0.38.0") {
      statements.push(...createV038MigrationSql({ previous, next, provider }));
      continue;
    }
    const previousTables = new Map(
      previous.tables.map((table) => [table.ormName, table]),
    );
    for (const table of next.tables) {
      if (table.internal) continue;
      const previousTable = previousTables.get(table.ormName);
      statements.push(
        ...(previousTable
          ? createChangedTableSql(previousTable, table, provider, relationMode)
          : createAddedTableSql(table, provider, relationMode)),
      );
    }
  }
  return statements;
};

export const createV029AlterSql = (
  provider: ORMSQLProvider,
): readonly string[] => createSchemaMigrationSql("0.21.0", "0.29.0", provider);

export const createV031AlterSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] =>
  createSchemaMigrationSql("0.29.0", "0.31.0", provider, relationMode);

export const createV036AlterSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] =>
  createSchemaMigrationSql("0.31.0", "0.36.0", provider, relationMode);

export const createV037AlterSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] =>
  createSchemaMigrationSql("0.36.0", "0.37.0", provider, relationMode);

export const createV038AlterSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] =>
  createSchemaMigrationSql("0.37.0", "0.38.0", provider, relationMode);
