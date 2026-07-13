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
  uuid,
  varchar,
} from "./dsl";
import { createSettingsTable } from "./settings";
import { HOT_UPDATER_SETTINGS_TABLE } from "./types";

export const channelsV036 = table(
  "channels",
  {
    id: idColumn("id", varchar(255)),
    name: column("name", varchar(255)),
  },
  {
    indexes: [uniqueIndex("channels_name_key", ["name"])],
  },
);

export const bundlesV036 = table(
  "bundles",
  {
    id: idColumn("id", "uuid"),
    platform: stringColumn("platform"),
    should_force_update: bool("should_force_update"),
    enabled: bool("enabled"),
    file_hash: stringColumn("file_hash"),
    git_commit_hash: stringColumn("git_commit_hash").nullable(),
    message: stringColumn("message").nullable(),
    channel_id: column("channel_id", varchar(255)),
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
        name: "channelRef",
        fieldName: "bundles",
        targetFieldName: "channelRef",
        relationName: "channels_bundles_channel",
        columns: ["channel_id"],
        referencedTable: "channels",
        referencedColumns: ["id"],
      }),
    ],
  },
);

export const bundlePatchesV036 = table(
  "bundle_patches",
  {
    id: idColumn("id", varchar(255)),
    bundle_id: uuid("bundle_id"),
    base_bundle_id: uuid("base_bundle_id"),
    base_file_hash: column("base_file_hash", "string"),
    patch_file_hash: column("patch_file_hash", "string"),
    patch_storage_uri: column("patch_storage_uri", "string"),
    order_index: integer("order_index").defaultTo(0),
  },
  {
    indexes: [
      index("bundle_patches_bundle_id_idx", ["bundle_id"]),
      index("bundle_patches_base_bundle_id_idx", ["base_bundle_id"]),
    ],
    foreignKeys: [
      foreignKey("bundle_patches_bundle_id_fk", ["bundle_id"], "bundles", [
        "id",
      ]),
      foreignKey(
        "bundle_patches_base_bundle_id_fk",
        ["base_bundle_id"],
        "bundles",
        ["id"],
      ),
    ],
    relations: [
      relation({
        name: "bundle",
        fieldName: "patches",
        targetFieldName: "bundle",
        relationName: "bundle_patches_bundles_patches",
        columns: ["bundle_id"],
        referencedTable: "bundles",
        referencedColumns: ["id"],
      }),
      relation({
        name: "baseBundle",
        fieldName: "baseForPatches",
        targetFieldName: "baseBundle",
        relationName: "bundle_patches_bundles_baseForPatches",
        columns: ["base_bundle_id"],
        referencedTable: "bundles",
        referencedColumns: ["id"],
      }),
    ],
  },
);

export const v0_36_0 = schema({
  version: "0.36.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [
    channelsV036,
    bundlesV036,
    bundlePatchesV036,
    createSettingsTable("0.36.0"),
  ],
});
