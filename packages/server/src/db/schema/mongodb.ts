import type { MigrationOperation } from "../types";
import { hotUpdaterSchema, schemaIndexAppliesToProvider } from "./registry";
import { hotUpdaterCreateTableOperations } from "./sql";

export const createMongoMigrationOperations = (
  settingsOperation?: MigrationOperation,
  options: { readonly normalizeChannels?: boolean } = {},
): MigrationOperation[] => [
  ...hotUpdaterCreateTableOperations,
  ...(options.normalizeChannels
    ? [
        {
          description:
            "Backfill persistent MongoDB channels and bundles.channel_id",
          type: "custom" as const,
        },
        {
          description:
            "Validate MongoDB bundle Channel references before constraints",
          type: "custom" as const,
        },
      ]
    : []),
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
  {
    description: "Require channel and channel_id on MongoDB bundle documents",
    type: "custom",
  },
  ...(settingsOperation ? [settingsOperation] : []),
];
