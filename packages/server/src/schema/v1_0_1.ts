import { index, schema } from "./dsl";
import { createSettingsTable } from "./settings";
import type { HotUpdaterColumnSchema, HotUpdaterTableSchema } from "./types";
import { bundleEventsV100, bundleInstallationsV100, v1_0_0 } from "./v1_0_0";

const exactTextColumns = new Set([
  "install_id",
  "user_id",
  "platform",
  "channel",
]);
const insightsProviders = [
  "postgresql",
  "mysql",
  "sqlite",
  "cockroachdb",
  "mongodb",
] as const;

const withExactInsightsText = (
  table: HotUpdaterTableSchema,
): readonly HotUpdaterColumnSchema[] =>
  table.columns.map((column) =>
    exactTextColumns.has(column.ormName)
      ? {
          ...column,
          providerCollations: { postgresql: '"C"', mysql: "utf8mb4_0900_bin" },
        }
      : column,
  );

export const bundleEventsV101: HotUpdaterTableSchema = {
  ...bundleEventsV100,
  columns: withExactInsightsText(bundleEventsV100),
  indexes: [
    ...(bundleEventsV100.indexes ?? []),
    index(
      "bundle_events_from_bundle_idx",
      ["type", "platform", "channel", "from_bundle_id", "received_at_ms", "id"],
      insightsProviders,
    ),
    index(
      "bundle_events_to_bundle_idx",
      ["type", "platform", "channel", "to_bundle_id", "received_at_ms", "id"],
      insightsProviders,
    ),
  ],
};

export const bundleInstallationsV101: HotUpdaterTableSchema = {
  ...bundleInstallationsV100,
  columns: withExactInsightsText(bundleInstallationsV100),
  indexes: [
    ...(bundleInstallationsV100.indexes ?? []),
    index(
      "bundle_installations_scope_idx",
      ["platform", "channel", "received_at_ms"],
      insightsProviders,
    ),
    index(
      "bundle_installations_bundle_idx",
      ["platform", "channel", "to_bundle_id", "received_at_ms"],
      insightsProviders,
    ),
  ],
};

export const v1_0_1 = schema({
  ...v1_0_0,
  version: "1.0.1",
  tables: v1_0_0.tables.map((table) => {
    if (table.ormName === "bundle_events") return bundleEventsV101;
    if (table.ormName === "bundle_installations")
      return bundleInstallationsV101;
    if (table.ormName === v1_0_0.settingsTable)
      return createSettingsTable("1.0.1");
    return table;
  }),
});
