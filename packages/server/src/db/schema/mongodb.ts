import type { MigrationOperation } from "../types";
import { hotUpdaterSchema, schemaIndexAppliesToProvider } from "./registry";
import { hotUpdaterCreateTableOperations } from "./sql";

export const createMongoMigrationOperations = (
  settingsOperation?: MigrationOperation,
): MigrationOperation[] => [
  ...hotUpdaterCreateTableOperations,
  {
    type: "custom",
    sql: "backfill channels(id, name) and bundles.channel_id from bundles.channel",
  },
  {
    type: "custom",
    sql: "create index bundles_id_idx on bundles(id)",
  },
  ...hotUpdaterSchema.tables.flatMap((table) =>
    (table.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, "mongodb"))
      .map(
        (index): MigrationOperation => ({
          type: "custom",
          sql: `create ${index.unique ? "unique " : ""}index ${index.name} on ${table.ormName}(${index.columns.join(
            ", ",
          )})`,
        }),
      ),
  ),
  ...(settingsOperation ? [settingsOperation] : []),
];
