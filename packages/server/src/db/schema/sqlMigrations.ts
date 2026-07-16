import { hotUpdaterSchemaVersions } from "../../schema";
import type { RelationMode } from "../types";
import type { ORMSQLProvider } from "../types";
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

const getSchemaVersionIndex = (version: string): number =>
  hotUpdaterSchemaVersions.findIndex((schema) => schema.version === version);

const createV036MigrationSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): readonly string[] => {
  const previous = hotUpdaterSchemaVersions.find(
    (schema) => schema.version === "0.31.0",
  );
  const next = hotUpdaterSchemaVersions.find(
    (schema) => schema.version === "0.36.0",
  );
  if (!previous || !next) {
    throw new Error("Hot Updater schema version 0.36.0 is incomplete.");
  }
  const channels = next.tables.find((table) => table.ormName === "channels");
  const bundles = next.tables.find((table) => table.ormName === "bundles");
  const previousBundles = previous.tables.find(
    (table) => table.ormName === "bundles",
  );
  if (!channels || !bundles || !previousBundles) {
    throw new Error("Hot Updater schema version 0.36.0 is incomplete.");
  }
  const previousBundleIndexes = new Set(
    (previousBundles.indexes ?? []).map((index) => index.name),
  );
  const createChannels = createTableStatement(channels, provider, relationMode);
  const channelIndexSql = (channels.indexes ?? [])
    .filter((index) => schemaIndexAppliesToProvider(index, provider))
    .map((index) => createIndexSql(channels, index, provider));
  const bundleIndexSql = (bundles.indexes ?? [])
    .filter((index) => schemaIndexAppliesToProvider(index, provider))
    .filter((index) => !previousBundleIndexes.has(index.name))
    .map((index) => createIndexSql(bundles, index, provider));
  const channelIdColumn = bundles.columns.find(
    (column) => column.ormName === "channel_id",
  );
  if (!channelIdColumn) {
    throw new Error(
      "Hot Updater schema version 0.36.0 bundles.channel_id is missing.",
    );
  }
  const nullableChannelIdColumn = sqlColumnDefinition(
    bundles,
    channelIdColumn,
    provider,
  ).replace(/\s+not null(?=(?:\s+default|$))/i, "");
  if (provider === "sqlite") {
    const bundleColumns = bundles.columns.map((column) => column.ormName);
    const createBundlesV036 = createTableStatement(
      bundles,
      provider,
      relationMode,
    ).replace(
      /^create table if not exists bundles/i,
      "create table bundles_v036",
    );
    const selectColumns = bundleColumns.map((column) =>
      column === "channel_id"
        ? "coalesce((select channels.id from channels where channels.name = bundles.channel), bundles.channel) as channel_id"
        : column,
    );
    return [
      "pragma foreign_keys = off",
      createChannels,
      ...channelIndexSql,
      "insert into channels (id, name) select distinct channel, channel from bundles where channel is not null on conflict do nothing",
      createBundlesV036,
      `insert into bundles_v036 (${bundleColumns.join(", ")}) select ${selectColumns.join(", ")} from bundles`,
      "drop table bundles",
      "alter table bundles_v036 rename to bundles",
      ...bundleIndexSql,
      "pragma foreign_key_check",
      "pragma foreign_keys = on",
    ];
  }
  const addChannelIdColumn = `alter table bundles add column ${nullableChannelIdColumn}`;
  if (provider === "mysql") {
    return [
      createChannels,
      ...channelIndexSql,
      addChannelIdColumn,
      "insert into channels (id, name) select distinct channel, channel from bundles where channel is not null",
      "update bundles join channels on channels.name = bundles.channel set bundles.channel_id = channels.id",
      "alter table bundles modify column channel_id varchar(255) not null",
      ...bundleIndexSql,
      ...(relationMode === "foreign-keys"
        ? (bundles.foreignKeys ?? []).map((foreignKey) =>
            createForeignKeySql(bundles, foreignKey),
          )
        : []),
    ];
  }
  return [
    createChannels,
    ...channelIndexSql,
    addChannelIdColumn,
    "insert into channels (id, name) select distinct channel, channel from bundles where channel is not null on conflict do nothing",
    "update bundles set channel_id = channels.id from channels where channels.name = bundles.channel",
    "alter table bundles alter column channel_id set not null",
    ...bundleIndexSql,
    ...(relationMode === "foreign-keys"
      ? (bundles.foreignKeys ?? []).map((foreignKey) =>
          createForeignKeySql(bundles, foreignKey),
        )
      : []),
  ];
};

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
    const previous = hotUpdaterSchemaVersions[index - 1]!;
    const next = hotUpdaterSchemaVersions[index]!;
    if (previous.version === "0.31.0" && next.version === "0.36.0") {
      assertV036MigrationSchemaDriftIsAllowlisted(previous, next, provider);
      statements.push(...createV036MigrationSql(provider, relationMode));
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
