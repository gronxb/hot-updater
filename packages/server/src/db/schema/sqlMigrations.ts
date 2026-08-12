import { hotUpdaterSchemaVersions } from "../../schema";
import type { HotUpdaterTableSchema } from "../../schema/types";
import type { ORMSQLProvider, RelationMode } from "../types";
import { schemaIndexAppliesToProvider } from "./registry";
import {
  assertExistingSchemaMetadataIsPreserved,
  assertV036MigrationSchemaDriftIsAllowlisted,
  assertV038MigrationSchemaDriftIsAllowlisted,
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

const CHANNEL_BACKFILL_CHECK_TABLE =
  "private_hot_updater_channel_backfill_check";
export const SQLITE_RESTORE_BUNDLES_SCHEMA_MARKER =
  "-- hot-updater:restore-bundles-user-schema";

const getRequiredTable = (
  schema: (typeof hotUpdaterSchemaVersions)[number],
  tableName: string,
): HotUpdaterTableSchema => {
  const table = schema.tables.find(({ ormName }) => ormName === tableName);
  if (!table) {
    throw new Error(
      `Hot Updater schema ${schema.version} is missing ${tableName}.`,
    );
  }
  return table;
};

const createTableIfMissingSql = (
  table: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): string => {
  const statement = createTableStatement(table, provider, relationMode);
  return provider === "mssql"
    ? `if object_id(N'${table.ormName}', N'U') is null\n${statement}`
    : statement.replace("create table ", "create table if not exists ");
};

const channelIdExpression = (provider: ORMSQLProvider): string => {
  if (provider === "sqlite") return "lower(hex(randomblob(16)))";
  if (provider === "mysql") return "lower(uuid())";
  if (provider === "mssql") {
    return "lower(convert(varchar(36), newid()))";
  }
  return "gen_random_uuid()::text";
};

const validationSql = (
  checkName: string,
  invalidCount: string,
): readonly string[] => [
  `drop table if exists ${CHANNEL_BACKFILL_CHECK_TABLE}`,
  `create table ${CHANNEL_BACKFILL_CHECK_TABLE} (invalid_count integer not null constraint ${checkName} check (invalid_count = 0))`,
  `insert into ${CHANNEL_BACKFILL_CHECK_TABLE} (invalid_count) ${invalidCount}`,
  `drop table ${CHANNEL_BACKFILL_CHECK_TABLE}`,
];

const channelNameLengthSql = (provider: ORMSQLProvider): string =>
  provider === "sqlite"
    ? "length(channel)"
    : provider === "mssql"
      ? "len(channel collate Latin1_General_100_BIN2_SC + N'#') - 1"
      : "char_length(channel)";

const exactChannelNameSql = (
  provider: ORMSQLProvider,
  expression: string,
): string => {
  if (provider === "mysql") {
    return `convert(${expression} using utf8mb4) collate utf8mb4_bin`;
  }
  if (provider === "mssql") {
    return `${expression} collate Latin1_General_100_BIN2_SC`;
  }
  if (provider === "sqlite") return `${expression} collate binary`;
  return expression;
};

const channelNameValidationSql = (
  provider: ORMSQLProvider,
): readonly string[] =>
  validationSql(
    "hot_updater_channel_name_is_valid",
    `select count(*) from bundles where channel = '' or ${channelNameLengthSql(provider)} > 255`,
  );

const channelBackfillValidationSql = (
  joinCondition: string,
): readonly string[] =>
  validationSql(
    "hot_updater_channel_backfill_is_complete",
    `select count(*) from bundles left join channels on ${joinCondition} where channels.id is null`,
  );

const createSqliteV038MigrationSql = (
  previous: (typeof hotUpdaterSchemaVersions)[number],
  next: (typeof hotUpdaterSchemaVersions)[number],
  relationMode: RelationMode,
): readonly string[] => {
  const previousBundles = getRequiredTable(previous, "bundles");
  const bundles = getRequiredTable(next, "bundles");
  const channels = getRequiredTable(next, "channels");
  const temporaryBundles = { ...bundles, ormName: "bundles_v038" };
  const columnNames = bundles.columns.map(({ ormName }) => ormName);
  const selectValues = columnNames.map((columnName) =>
    columnName === "channel_id"
      ? `(select channels.id from channels where channels.name = ${exactChannelNameSql("sqlite", "bundles.channel")})`
      : `bundles.${columnName}`,
  );
  const indexes = [
    ...(channels.indexes ?? []).map((index) =>
      createIndexSql(channels, index, "sqlite").replace(
        "create unique index ",
        "create unique index if not exists ",
      ),
    ),
    ...(bundles.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, "sqlite"))
      .map((index) => createIndexSql(bundles, index, "sqlite")),
  ];

  assertExistingSchemaMetadataIsPreserved(previousBundles, bundles, "sqlite");

  return [
    "pragma foreign_keys = off",
    createTableIfMissingSql(channels, "sqlite", relationMode),
    ...channelNameValidationSql("sqlite"),
    `insert into channels (id, name) select ${channelIdExpression("sqlite")}, legacy.channel from (select distinct ${exactChannelNameSql("sqlite", "channel")} as channel from bundles) as legacy where not exists (select 1 from channels where channels.name = legacy.channel)`,
    ...channelBackfillValidationSql(
      `channels.name = ${exactChannelNameSql("sqlite", "bundles.channel")}`,
    ),
    ...indexes.slice(0, channels.indexes?.length ?? 0),
    "drop table if exists bundles_v038",
    createTableStatement(temporaryBundles, "sqlite", relationMode),
    `insert into bundles_v038 (${columnNames.join(", ")}) select ${selectValues.join(", ")} from bundles`,
    "drop table bundles",
    "alter table bundles_v038 rename to bundles",
    ...indexes.slice(channels.indexes?.length ?? 0),
    SQLITE_RESTORE_BUNDLES_SCHEMA_MARKER,
    "pragma foreign_key_check",
    "pragma foreign_keys = on",
  ];
};

const createRelationalV038MigrationSql = (
  previous: (typeof hotUpdaterSchemaVersions)[number],
  next: (typeof hotUpdaterSchemaVersions)[number],
  provider: Exclude<ORMSQLProvider, "sqlite">,
  relationMode: RelationMode,
): readonly string[] => {
  const previousBundles = getRequiredTable(previous, "bundles");
  const bundles = getRequiredTable(next, "bundles");
  const channels = getRequiredTable(next, "channels");
  const channelId = bundles.columns.find(
    ({ ormName }) => ormName === "channel_id",
  );
  const channelNameIndex = channels.indexes?.find(
    ({ name }) => name === "channels_name_key",
  );
  const bundleChannelIndex = bundles.indexes?.find(
    ({ name }) => name === "bundles_channel_id_idx",
  );
  const channelForeignKey = bundles.foreignKeys?.find(
    ({ name }) => name === "bundles_channel_id_fk",
  );
  if (
    !channelId ||
    !channelNameIndex ||
    !bundleChannelIndex ||
    !channelForeignKey
  ) {
    throw new Error(
      "Hot Updater schema 0.38.0 channel metadata is incomplete.",
    );
  }
  assertExistingSchemaMetadataIsPreserved(previousBundles, bundles, provider);
  const nullableChannelId = { ...channelId, nullable: true };
  const channelIdDefinition = sqlColumnDefinition(bundles, channelId, provider);
  const setNotNull =
    provider === "mysql"
      ? `alter table bundles modify column ${channelIdDefinition}`
      : provider === "mssql"
        ? `alter table bundles alter column ${channelIdDefinition}`
        : "alter table bundles alter column channel_id set not null";

  return [
    createTableIfMissingSql(channels, provider, relationMode),
    `alter table bundles add column ${sqlColumnDefinition(bundles, nullableChannelId, provider)}`,
    ...channelNameValidationSql(provider),
    `insert into channels (id, name) select ${channelIdExpression(provider)}, legacy.channel from (select distinct ${exactChannelNameSql(provider, "channel")} as channel from bundles) as legacy where not exists (select 1 from channels where channels.name = legacy.channel)`,
    `update bundles set channel_id = (select channels.id from channels where channels.name = ${exactChannelNameSql(provider, "bundles.channel")}) where channel_id is null`,
    ...channelBackfillValidationSql(
      `channels.id = bundles.channel_id and channels.name = ${exactChannelNameSql(provider, "bundles.channel")}`,
    ),
    createIndexSql(channels, channelNameIndex, provider),
    ...(channels.checks ?? []).map((check) =>
      createCheckSql(channels, check, provider),
    ),
    setNotNull,
    createIndexSql(bundles, bundleChannelIndex, provider),
    ...(relationMode === "foreign-keys"
      ? [createForeignKeySql(bundles, channelForeignKey, provider)]
      : []),
  ];
};

const createV038MigrationSql = (
  previous: (typeof hotUpdaterSchemaVersions)[number],
  next: (typeof hotUpdaterSchemaVersions)[number],
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): readonly string[] =>
  provider === "sqlite"
    ? createSqliteV038MigrationSql(previous, next, relationMode)
    : createRelationalV038MigrationSql(previous, next, provider, relationMode);

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
    : (table.checks ?? []).map((check) =>
        createCheckSql(table, check, provider),
      )),
  ...(relationMode === "foreign-keys" && provider !== "sqlite"
    ? (table.foreignKeys ?? []).map((foreignKey) =>
        createForeignKeySql(table, foreignKey, provider),
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
          .map((check) => createCheckSql(next, check, provider))),
    ...(relationMode === "foreign-keys" && provider !== "sqlite"
      ? (next.foreignKeys ?? [])
          .filter((foreignKey) => !previousForeignKeys.has(foreignKey.name))
          .map((foreignKey) => createForeignKeySql(next, foreignKey, provider))
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
      continue;
    }
    if (previous.version === "0.37.0" && next.version === "0.38.0") {
      assertV038MigrationSchemaDriftIsAllowlisted(previous, next, provider);
      statements.push(
        ...createV038MigrationSql(previous, next, provider, relationMode),
      );
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

export const createV038AlterSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] =>
  createSchemaMigrationSql("0.37.0", "0.38.0", provider, relationMode);
