import type { MigrationOperation } from "../types";
import { hotUpdaterSchema, schemaIndexAppliesToProvider } from "./registry";
import { hotUpdaterCreateTableOperations } from "./sql";

export const createMongoMigrationOperations = (
  settingsOperation?: MigrationOperation,
  insightsOnly = false,
): MigrationOperation[] => [
  ...(insightsOnly ? [] : hotUpdaterCreateTableOperations),
  ...hotUpdaterSchema.tables
    .filter(
      (table) =>
        !table.internal &&
        (!insightsOnly ||
          table.ormName === "bundle_events" ||
          table.ormName === "bundle_installations"),
    )
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
  ...hotUpdaterSchema.tables
    .filter(
      (table) =>
        !insightsOnly ||
        table.ormName === "bundle_events" ||
        table.ormName === "bundle_installations",
    )
    .flatMap((table) =>
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
  ...(insightsOnly
    ? []
    : [
        {
          description:
            "Enforce final MongoDB Bundle, Release, and catalog schemas",
          type: "custom" as const,
        },
      ]),
  ...(settingsOperation ? [settingsOperation] : []),
];
