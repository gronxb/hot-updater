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
        description: `Create unique MongoDB index: ${table.ormName}_id_idx on ${table.ormName}(id)`,
        type: "custom",
      }),
    ),
  ...hotUpdaterSchema.tables.flatMap((table) =>
    (table.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, "mongodb"))
      .map(
        (index): MigrationOperation => ({
          description: `Create ${index.unique ? "unique " : ""}MongoDB index: ${index.name} on ${table.ormName}(${index.columns.join(
            ", ",
          )})`,
          type: "custom",
        }),
      ),
  ),
  ...(settingsOperation ? [settingsOperation] : []),
];
