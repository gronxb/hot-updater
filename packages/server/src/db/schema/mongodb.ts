import type { MigrationOperation } from "../types";
import { hotUpdaterSchema, schemaIndexAppliesToProvider } from "./registry";
import { hotUpdaterCreateTableOperations } from "./sql";

export const createMongoMigrationOperations = (
  settingsOperation?: MigrationOperation,
): MigrationOperation[] => [
  ...hotUpdaterCreateTableOperations,
  ...hotUpdaterSchema.tables
    .filter((table) => !table.internal)
    .map(
      (table): MigrationOperation => ({
        type: "custom",
        sql: `create unique index ${table.ormName}_id_idx on ${table.ormName}(id)`,
      }),
    ),
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
