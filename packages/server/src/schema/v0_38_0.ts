import {
  bool,
  check,
  column,
  foreignKey,
  idColumn,
  index,
  integer,
  json,
  relation,
  schema,
  stringColumn,
  table,
  uniqueIndex,
  varchar,
} from "./dsl";
import { createSettingsTable } from "./settings";
import { HOT_UPDATER_SETTINGS_TABLE } from "./types";
import { bundlePatchesV036 } from "./v0_36_0";
import { bundleEventsV037, clientAccessKeysV037 } from "./v0_37_0";

const channelIdentityCollations = {
  mysql: "utf8mb4_bin",
  mssql: "Latin1_General_100_BIN2_SC",
  sqlite: "binary",
} as const;

export const channelsV038 = table(
  "channels",
  {
    id: idColumn("id", varchar(255)).collate(channelIdentityCollations),
    name: column("name", varchar(255)).collate(channelIdentityCollations),
  },
  {
    indexes: [uniqueIndex("channels_name_key", ["name"])],
    checks: [
      check({
        name: "channels_id_length_check",
        expression: "char_length(id) between 1 and 255",
        providerExpressions: {
          mssql:
            "len(id collate Latin1_General_100_BIN2_SC + N'#') - 1 between 1 and 255",
          sqlite: "length(id) between 1 and 255",
        },
        sqliteInline: true,
      }),
      check({
        name: "channels_name_length_check",
        expression: "char_length(name) between 1 and 255",
        providerExpressions: {
          mssql:
            "len(name collate Latin1_General_100_BIN2_SC + N'#') - 1 between 1 and 255",
          sqlite: "length(name) between 1 and 255",
        },
        sqliteInline: true,
      }),
    ],
  },
);

export const bundlesV038 = table(
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
    channel_id: column("channel_id", varchar(255)).collate(
      channelIdentityCollations,
    ),
    storage_uri: stringColumn("storage_uri"),
    target_app_version: stringColumn("target_app_version").nullable(),
    fingerprint_hash: stringColumn("fingerprint_hash").nullable(),
    metadata: json("metadata").defaultTo({}),
    rollout_cohort_count: integer("rollout_cohort_count").defaultTo(1000),
    target_cohorts: json("target_cohorts").nullable(),
    manifest_storage_uri: stringColumn("manifest_storage_uri").nullable(),
    manifest_file_hash: stringColumn("manifest_file_hash").nullable(),
    asset_base_storage_uri: stringColumn("asset_base_storage_uri").nullable(),
  },
  {
    indexes: [
      index("bundles_target_app_version_idx", ["target_app_version"]),
      index("bundles_fingerprint_hash_idx", ["fingerprint_hash"]),
      index("bundles_channel_idx", ["channel"]),
      index("bundles_channel_id_idx", ["channel_id"]),
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
    foreignKeys: [
      foreignKey("bundles_channel_id_fk", ["channel_id"], "channels", ["id"], {
        onDelete: "restrict",
      }),
    ],
    relations: [
      relation({
        name: "channelRecord",
        fieldName: "bundles",
        targetFieldName: "channelRecord",
        relationName: "bundles_channels",
        columns: ["channel_id"],
        referencedTable: "channels",
        referencedColumns: ["id"],
      }),
    ],
  },
);

export const v0_38_0 = schema({
  version: "0.38.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [
    channelsV038,
    bundlesV038,
    bundlePatchesV036,
    bundleEventsV037,
    clientAccessKeysV037,
    createSettingsTable("0.38.0"),
  ],
});
