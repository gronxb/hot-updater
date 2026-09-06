import type { MigrationOperation } from "../types";
import { hotUpdaterSchema, schemaIndexAppliesToProvider } from "./registry";
import { hotUpdaterCreateTableOperations } from "./sql";

export const createMongoMigrationOperations = (
  settingsOperation?: MigrationOperation,
): MigrationOperation[] => [
  ...hotUpdaterCreateTableOperations,
  ...hotUpdaterSchema.tables
    .filter((table) => !table.internal)
    .map((table): MigrationOperation => {
      const primaryKey = table.columns.find((column) => column.primaryKey);
      if (!primaryKey) {
        throw new Error(
          `MongoDB table ${table.ormName} does not define a primary key.`,
        );
      }
      return {
        description: `Create unique MongoDB index: ${table.ormName}_${primaryKey.ormName}_idx on ${table.ormName}(${primaryKey.ormName})`,
        type: "custom",
      };
    }),
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
  {
    description: "Enforce final MongoDB Bundle, Release, and catalog schemas",
    type: "custom",
  },
  ...(settingsOperation ? [settingsOperation] : []),
];
