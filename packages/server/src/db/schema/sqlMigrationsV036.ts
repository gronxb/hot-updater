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
  const bundleChannels = next.tables.find(
    (table) => table.ormName === "bundle_channels",
  );
  const bundles = next.tables.find((table) => table.ormName === "bundles");
  const previousBundles = previous.tables.find(
    (table) => table.ormName === "bundles",
  );
  if (!bundleChannels || !bundles || !previousBundles) {
    throw new Error("Hot Updater schema version 0.36.0 is incomplete.");
  }
  const previousBundleIndexes = new Set(
    (previousBundles.indexes ?? []).map((index) => index.name),
  );
  const createBundleChannels = createTableStatement(
    bundleChannels,
    provider,
    relationMode,
  );
  const channelIndexSql = (bundleChannels.indexes ?? [])
    .filter((index) => schemaIndexAppliesToProvider(index, provider))
    .map((index) => createIndexSql(bundleChannels, index, provider));
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
    const channelRelation =
      relationMode === "foreign-keys"
        ? " references bundle_channels(id) on update restrict on delete restrict"
        : "";
    return [
      createBundleChannels,
      ...channelIndexSql,
      "insert into bundle_channels (id, name) select distinct channel, channel from bundles where channel is not null on conflict do nothing",
      `alter table bundles add column ${nullableChannelIdColumn}${channelRelation}`,
      "update bundles set channel_id = coalesce((select bundle_channels.id from bundle_channels where bundle_channels.name = bundles.channel), bundles.channel)",
      "create trigger bundles_channel_id_not_null_insert before insert on bundles when new.channel_id is null begin select raise(abort, 'bundles.channel_id must not be null'); end",
      "create trigger bundles_channel_id_not_null_update before update of channel_id on bundles when new.channel_id is null begin select raise(abort, 'bundles.channel_id must not be null'); end",
      ...bundleIndexSql,
    ];
  }
  const addChannelIdColumn = `alter table bundles add column ${nullableChannelIdColumn}`;
  if (provider === "mysql") {
    return [
      createBundleChannels,
      ...channelIndexSql,
      addChannelIdColumn,
      "insert into bundle_channels (id, name) select distinct channel, channel from bundles where channel is not null",
      "update bundles join bundle_channels on bundle_channels.name = bundles.channel set bundles.channel_id = bundle_channels.id",
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
    createBundleChannels,
    ...channelIndexSql,
    addChannelIdColumn,
    "insert into bundle_channels (id, name) select distinct channel, channel from bundles where channel is not null on conflict do nothing",
    "update bundles set channel_id = bundle_channels.id from bundle_channels where bundle_channels.name = bundles.channel",
    "alter table bundles alter column channel_id set not null",
    ...bundleIndexSql,
    ...(relationMode === "foreign-keys"
      ? (bundles.foreignKeys ?? []).map((foreignKey) =>
          createForeignKeySql(bundles, foreignKey),
        )
      : []),
  ];
};
