import { createSettingsTable } from "./settings";
import {
  HOT_UPDATER_SETTINGS_TABLE,
  type HotUpdaterTableSchema,
  type HotUpdaterVersionedSchema,
} from "./types";
import { bundlesV021 } from "./v0_21_0";

export const bundlesV029 = {
  ...bundlesV021,
  columns: [
    ...bundlesV021.columns,
    {
      ormName: "rollout_cohort_count",
      type: "integer",
      default: { type: "literal", value: 1000 },
    },
    { ormName: "target_cohorts", type: "json", nullable: true },
  ],
  indexes: [
    ...bundlesV021.indexes,
    { name: "bundles_rollout_idx", columns: ["rollout_cohort_count"] },
  ],
  checks: [
    ...bundlesV021.checks,
    {
      name: "bundles_rollout_cohort_count_check",
      expression: "rollout_cohort_count >= 0 and rollout_cohort_count <= 1000",
      sqliteInline: true,
    },
  ],
} as const satisfies HotUpdaterTableSchema;

export const v0_29_0 = {
  version: "0.29.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [bundlesV029, createSettingsTable("0.29.0")],
} as const satisfies HotUpdaterVersionedSchema;
