import {
  bool,
  check,
  idColumn,
  index,
  json,
  schema,
  stringColumn,
  table,
} from "./dsl";
import { createSettingsTable } from "./settings";
import { HOT_UPDATER_SETTINGS_TABLE } from "./types";

export const bundlesV021 = table(
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
  },
  {
    indexes: [
      index("bundles_target_app_version_idx", ["target_app_version"]),
      index("bundles_fingerprint_hash_idx", ["fingerprint_hash"]),
      index("bundles_channel_idx", ["channel"]),
      index("bundles_platform_idx", ["platform"], ["mongodb"]),
    ],
    checks: [
      check({
        name: "check_version_or_fingerprint",
        expression:
          "(target_app_version is not null) or (fingerprint_hash is not null)",
        sqliteInline: true,
      }),
    ],
  },
);

export const v0_21_0 = schema({
  version: "0.21.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [bundlesV021, createSettingsTable("0.21.0")],
});
