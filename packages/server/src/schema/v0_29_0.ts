import {
  bool,
  check,
  idColumn,
  index,
  integer,
  json,
  schema,
  stringColumn,
  table,
} from "./dsl";
import { createSettingsTable } from "./settings";
import { HOT_UPDATER_SETTINGS_TABLE } from "./types";

export const bundlesV029 = table(
  "bundles",
  {
    id: idColumn("id", "uuid"),
    platform: stringColumn("platform"),
    should_force_update: bool("should_force_update"),
    enabled: bool("enabled"),
    file_hash: stringColumn("file_hash"),
    git_commit_hash: stringColumn("git_commit_hash").nullable(),
    message: stringColumn("message").nullable(),
    channel: stringColumn("channel").defaultTo("production"),
    storage_uri: stringColumn("storage_uri"),
    target_app_version: stringColumn("target_app_version").nullable(),
    fingerprint_hash: stringColumn("fingerprint_hash").nullable(),
    metadata: json("metadata").defaultTo({}),
    rollout_cohort_count: integer("rollout_cohort_count").defaultTo(1000),
    target_cohorts: json("target_cohorts").nullable(),
  },
  {
    indexes: [
      index("bundles_target_app_version_idx", ["target_app_version"]),
      index("bundles_fingerprint_hash_idx", ["fingerprint_hash"]),
      index("bundles_channel_idx", ["channel"]),
      index("bundles_platform_idx", ["platform"], ["mongodb"]),
      index("bundles_rollout_idx", ["rollout_cohort_count"]),
    ],
    checks: [
      check({
        name: "check_version_or_fingerprint",
        expression:
          "(target_app_version is not null) or (fingerprint_hash is not null)",
        sqliteInline: true,
      }),
      check({
        name: "bundles_rollout_cohort_count_check",
        expression:
          "rollout_cohort_count >= 0 and rollout_cohort_count <= 1000",
        sqliteInline: true,
      }),
    ],
  },
);

export const v0_29_0 = schema({
  version: "0.29.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [bundlesV029, createSettingsTable("0.29.0")],
});
