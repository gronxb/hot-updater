import { hotUpdaterSchemaVersions } from "../../schema";
import type {
  HotUpdaterCheckSchema,
  HotUpdaterForeignKeySchema,
  HotUpdaterTableSchema,
} from "../../schema/types";
import type { ORMSQLProvider, RelationMode } from "../types";
import {
  getSchemaVersionIndex,
  schemaIndexAppliesToProvider,
} from "./registry";
import {
  createIndexSql,
  createTableStatement,
  sqlColumnDefinition,
} from "./sql";

const nameMap = <T extends { readonly name: string }>(
  items: readonly T[] | undefined,
): Map<string, T> => new Map((items ?? []).map((item) => [item.name, item]));

const columnMap = (
  table: HotUpdaterTableSchema,
): Map<string, { readonly ormName: string }> =>
  new Map(table.columns.map((column) => [column.ormName, column]));

const stableStringify = (value: unknown): string => JSON.stringify(value);

const assertSameSchemaValue = (
  location: string,
  left: unknown,
  right: unknown,
) => {
  if (stableStringify(left) !== stableStringify(right)) {
    throw new Error(
      `Unsupported Hot Updater schema change at ${location}. Add an explicit migration step before changing existing schema metadata.`,
    );
  }
};

const compareNamedItems = <T extends { readonly name: string }>(
  location: string,
  previousItems: readonly T[] | undefined,
  nextItems: readonly T[] | undefined,
) => {
  const nextItemsByName = nameMap(nextItems);
  for (const previousItem of previousItems ?? []) {
    const nextItem = nextItemsByName.get(previousItem.name);
    if (!nextItem) {
      throw new Error(
        `Unsupported Hot Updater schema change at ${location}.${previousItem.name}. Removing schema metadata requires an explicit migration step.`,
      );
    }
    assertSameSchemaValue(
      `${location}.${previousItem.name}`,
      previousItem,
      nextItem,
    );
  }
};

const assertNoUnsupportedTableChanges = (
  previous: HotUpdaterTableSchema,
  next: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
) => {
  const nextColumns = columnMap(next);
  for (const previousColumn of previous.columns) {
    const nextColumn = nextColumns.get(previousColumn.ormName);
    if (!nextColumn) {
      throw new Error(
        `Unsupported Hot Updater schema change at ${previous.ormName}.${previousColumn.ormName}. Dropping columns requires an explicit migration step.`,
      );
    }
    assertSameSchemaValue(
      `${previous.ormName}.${previousColumn.ormName}`,
      previousColumn,
      nextColumn,
    );
  }
  compareNamedItems(
    `${previous.ormName}.indexes`,
    previous.indexes?.filter((index) =>
      schemaIndexAppliesToProvider(index, provider),
    ),
    next.indexes?.filter((index) =>
      schemaIndexAppliesToProvider(index, provider),
    ),
  );
  compareNamedItems(`${previous.ormName}.checks`, previous.checks, next.checks);
  compareNamedItems(
    `${previous.ormName}.foreignKeys`,
    previous.foreignKeys,
    next.foreignKeys,
  );
};

const createForeignKeySql = (
  table: HotUpdaterTableSchema,
  foreignKey: HotUpdaterForeignKeySchema,
): string =>
  `alter table ${table.ormName} add constraint ${foreignKey.name} foreign key (${foreignKey.columns.join(", ")}) references ${foreignKey.referencedTable}(${foreignKey.referencedColumns.join(", ")}) on update ${foreignKey.onUpdate} on delete ${foreignKey.onDelete}`;

const createCheckSql = (
  table: HotUpdaterTableSchema,
  check: HotUpdaterCheckSchema,
): string =>
  `alter table ${table.ormName} add constraint ${check.name} check (${check.expression})`;

const createAddedTableSql = (
  table: HotUpdaterTableSchema,
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

const createV036MigrationSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): readonly string[] => {
  const next = hotUpdaterSchemaVersions.find(
    (schema) => schema.version === "0.36.0",
  );
  if (!next) {
    throw new Error("Hot Updater schema version 0.36.0 is not registered.");
  }
  const channels = next.tables.find((table) => table.ormName === "channels");
  const bundles = next.tables.find((table) => table.ormName === "bundles");
  if (!channels || !bundles) {
    throw new Error("Hot Updater schema version 0.36.0 is incomplete.");
  }

  const createChannels = createTableStatement(channels, provider, relationMode);
  const channelNameIndex = channels.indexes?.find(
    (index) => index.name === "channels_name_key",
  );
  if (!channelNameIndex) {
    throw new Error("Hot Updater channels schema is missing its name index.");
  }
  const createChannelNameIndex = createIndexSql(
    channels,
    channelNameIndex,
    provider,
  );
  const backfillChannels =
    "insert into channels (id, name) select distinct channel, channel from bundles";
  const channelForeignKey = bundles.foreignKeys?.find(
    (foreignKey) => foreignKey.name === "bundles_channel_id_fk",
  );
  const channelIdIndex = bundles.indexes?.find(
    (index) => index.name === "bundles_channel_id_idx",
  );
  if (!channelIdIndex) {
    throw new Error("Hot Updater bundles schema is missing its channel index.");
  }

  if (provider !== "sqlite") {
    const addChannelId =
      "alter table bundles add column channel_id varchar(255)";
    const backfillBundleChannelIds =
      provider === "mysql"
        ? "update bundles join channels on channels.name = bundles.channel set bundles.channel_id = channels.id"
        : "update bundles set channel_id = channels.id from channels where channels.name = bundles.channel";
    const requireChannelId =
      provider === "mysql"
        ? "alter table bundles modify column channel_id varchar(255) not null"
        : "alter table bundles alter column channel_id set not null";
    return [
      createChannels,
      createChannelNameIndex,
      addChannelId,
      backfillChannels,
      backfillBundleChannelIds,
      requireChannelId,
      createIndexSql(bundles, channelIdIndex, provider),
      ...(relationMode === "foreign-keys" && channelForeignKey
        ? [createForeignKeySql(bundles, channelForeignKey)]
        : []),
      "alter table bundles drop column channel",
    ];
  }

  const temporaryBundles: HotUpdaterTableSchema = {
    ...bundles,
    ormName: "bundles_v036",
  };
  const columns = bundles.columns.map((column) => column.ormName).join(", ");
  const sourceColumns = bundles.columns
    .map((column) =>
      column.ormName === "channel_id"
        ? "channels.id"
        : `bundles.${column.ormName}`,
    )
    .join(", ");
  return [
    createChannels,
    createChannelNameIndex,
    backfillChannels,
    "pragma foreign_keys = off",
    createTableStatement(temporaryBundles, provider, relationMode),
    `insert into bundles_v036 (${columns}) select ${sourceColumns} from bundles join channels on channels.name = bundles.channel`,
    "drop table bundles",
    "alter table bundles_v036 rename to bundles",
    ...(bundles.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, provider))
      .map((index) => createIndexSql(bundles, index, provider)),
    "pragma foreign_keys = on",
    "pragma foreign_key_check",
  ];
};

const createChangedTableSql = (
  previous: HotUpdaterTableSchema,
  next: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): readonly string[] => {
  assertNoUnsupportedTableChanges(previous, next, provider);
  const previousColumns = columnMap(previous);
  const previousIndexes = nameMap(
    previous.indexes?.filter((index) =>
      schemaIndexAppliesToProvider(index, provider),
    ),
  );
  const previousChecks = nameMap(previous.checks);
  const previousForeignKeys = nameMap(previous.foreignKeys);

  return [
    ...next.columns
      .filter((column) => !previousColumns.has(column.ormName))
      .map(
        (column) =>
          `alter table ${next.ormName} add column ${sqlColumnDefinition(
            next,
            column,
            provider,
          )}`,
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
  if (fromIndex === -1) {
    throw new Error(`Unsupported Hot Updater schema version: ${fromVersion}`);
  }
  if (toIndex === -1) {
    throw new Error(`Unsupported Hot Updater schema version: ${toVersion}`);
  }
  if (fromIndex > toIndex) {
    throw new Error(`Cannot migrate Hot Updater schema down to ${toVersion}.`);
  }

  const statements: string[] = [];
  for (let index = fromIndex + 1; index <= toIndex; index += 1) {
    const previous = hotUpdaterSchemaVersions[index - 1]!;
    const next = hotUpdaterSchemaVersions[index]!;
    if (previous.version === "0.31.0" && next.version === "0.36.0") {
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
