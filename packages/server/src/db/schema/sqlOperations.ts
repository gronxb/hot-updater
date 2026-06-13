import {
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
} from "../../schema/types";
import type {
  MigrationOperation,
  ORMSQLProvider,
  RelationMode,
} from "../types";
import { hotUpdaterSchema, schemaIndexAppliesToProvider } from "./registry";
import {
  createCheckSql,
  createForeignKeySql,
  createIndexSql,
  hotUpdaterCreateTableOperations,
} from "./sql";

export const getSettingsInsertSql = (provider: ORMSQLProvider) => {
  if (provider === "mysql") {
    return `insert into ${HOT_UPDATER_SETTINGS_TABLE} (\`key\`, value) values ('version', '${HOT_UPDATER_SCHEMA_VERSION}') on duplicate key update value = '${HOT_UPDATER_SCHEMA_VERSION}'`;
  }
  return `insert into ${HOT_UPDATER_SETTINGS_TABLE} (key, value) values ('version', '${HOT_UPDATER_SCHEMA_VERSION}') on conflict (key) do update set value = '${HOT_UPDATER_SCHEMA_VERSION}'`;
};

export const createSqlCreateOperations = (
  provider: ORMSQLProvider,
  relationMode: RelationMode,
  settingsOperation?: MigrationOperation,
): MigrationOperation[] => [
  ...hotUpdaterCreateTableOperations,
  ...hotUpdaterSchema.tables.flatMap((table) =>
    (table.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, provider))
      .map(
        (index): MigrationOperation => ({
          type: "custom",
          sql: createIndexSql(table, index, provider),
        }),
      ),
  ),
  ...(provider === "sqlite"
    ? []
    : hotUpdaterSchema.tables.flatMap((table) =>
        (table.checks ?? []).map(
          (check): MigrationOperation => ({
            type: "custom",
            sql: createCheckSql(table, check),
          }),
        ),
      )),
  ...(relationMode === "foreign-keys" && provider !== "sqlite"
    ? hotUpdaterSchema.tables.flatMap((table) =>
        (table.foreignKeys ?? []).map(
          (foreignKey): MigrationOperation => ({
            type: "custom",
            sql: createForeignKeySql(table, foreignKey),
          }),
        ),
      )
    : []),
  ...(settingsOperation ? [settingsOperation] : []),
];
