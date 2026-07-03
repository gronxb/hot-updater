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
  uuid,
  varchar,
} from "./dsl";
import { createSettingsTable } from "./settings";
import { HOT_UPDATER_SETTINGS_TABLE } from "./types";

export const bundlesV031 = table(
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
    manifest_storage_uri: stringColumn("manifest_storage_uri").nullable(),
    manifest_file_hash: stringColumn("manifest_file_hash").nullable(),
    asset_base_storage_uri: stringColumn("asset_base_storage_uri").nullable(),
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

export const bundlePatchesV031 = table(
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

export const ingestKeysV031 = table(
  "ingest_keys",
  {
    id: idColumn("id", varchar(255)),
    key_hash: stringColumn("key_hash"),
    key_suffix: stringColumn("key_suffix"),
    active: bool("active").defaultTo(true),
    created_at: stringColumn("created_at"),
    updated_at: stringColumn("updated_at"),
  },
  {
    checks: [
      check({
        name: "ingest_keys_singleton_check",
        expression: "id = 'default'",
        sqliteInline: true,
      }),
    ],
  },
);

export const analyticsEventsV031 = table(
  "analytics_events",
  {
    id: idColumn("id", varchar(255)),
    event_type: stringColumn("event_type"),
    payload: json("payload"),
    observed_at: stringColumn("observed_at"),
    received_at: stringColumn("received_at"),
  },
  {
    indexes: [
      index("analytics_events_event_type_idx", ["event_type"]),
      index("analytics_events_observed_at_idx", ["observed_at"]),
    ],
  },
);

export const v0_31_0 = schema({
  version: "0.31.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [
    bundlesV031,
    bundlePatchesV031,
    ingestKeysV031,
    analyticsEventsV031,
    createSettingsTable("0.31.0"),
  ],
});
