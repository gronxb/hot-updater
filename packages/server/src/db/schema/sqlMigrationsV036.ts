import { hotUpdaterSchemaVersions } from "../../schema";
import type { ORMSQLProvider, RelationMode } from "../types";
import { schemaIndexAppliesToProvider } from "./registry";
import {
  createForeignKeySql,
  createIndexSql,
  createTableStatement,
  sqlColumnDefinition,
} from "./sql";

export const createV036MigrationSql = (
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
