import {
  HOT_UPDATER_SETTINGS_TABLE,
  type HotUpdaterSchemaVersion,
  type HotUpdaterTableSchema,
  type HotUpdaterVersionedSchema,
} from "./types";

const bundlesV021 = {
  ormName: "bundles",
  columns: [
    { ormName: "id", type: "uuid", primaryKey: true },
    { ormName: "platform", type: "string" },
    { ormName: "should_force_update", type: "bool" },
    { ormName: "enabled", type: "bool" },
    { ormName: "file_hash", type: "string" },
    { ormName: "git_commit_hash", type: "string", nullable: true },
    { ormName: "message", type: "string", nullable: true },
    {
      ormName: "channel",
      type: "string",
      default: { type: "literal", value: "production" },
    },
    { ormName: "storage_uri", type: "string" },
    { ormName: "target_app_version", type: "string", nullable: true },
    { ormName: "fingerprint_hash", type: "string", nullable: true },
    {
      ormName: "metadata",
      type: "json",
      default: { type: "json", value: {} },
    },
  ],
  indexes: [
    { name: "bundles_target_app_version_idx", columns: ["target_app_version"] },
    { name: "bundles_fingerprint_hash_idx", columns: ["fingerprint_hash"] },
    { name: "bundles_channel_idx", columns: ["channel"] },
    {
      name: "bundles_platform_idx",
      columns: ["platform"],
      providers: ["mongodb"],
    },
  ],
  checks: [
    {
      name: "check_version_or_fingerprint",
      expression:
        "(target_app_version is not null) or (fingerprint_hash is not null)",
      sqliteInline: true,
    },
  ],
} as const satisfies HotUpdaterTableSchema;

const bundlesV029 = {
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

const bundlesV031 = {
  ...bundlesV029,
  columns: [
    ...bundlesV029.columns,
    { ormName: "manifest_storage_uri", type: "string", nullable: true },
    { ormName: "manifest_file_hash", type: "string", nullable: true },
    { ormName: "asset_base_storage_uri", type: "string", nullable: true },
  ],
} as const satisfies HotUpdaterTableSchema;

const bundlePatchesV031 = {
  ormName: "bundle_patches",
  columns: [
    { ormName: "id", type: "varchar(255)", primaryKey: true },
    { ormName: "bundle_id", type: "uuid" },
    { ormName: "base_bundle_id", type: "uuid" },
    { ormName: "base_file_hash", type: "string" },
    { ormName: "patch_file_hash", type: "string" },
    { ormName: "patch_storage_uri", type: "string" },
    {
      ormName: "order_index",
      type: "integer",
      default: { type: "literal", value: 0 },
    },
  ],
  indexes: [
    { name: "bundle_patches_bundle_id_idx", columns: ["bundle_id"] },
    { name: "bundle_patches_base_bundle_id_idx", columns: ["base_bundle_id"] },
  ],
  foreignKeys: [
    {
      name: "bundle_patches_bundle_id_fk",
      columns: ["bundle_id"],
      referencedTable: "bundles",
      referencedColumns: ["id"],
      onUpdate: "restrict",
      onDelete: "cascade",
    },
    {
      name: "bundle_patches_base_bundle_id_fk",
      columns: ["base_bundle_id"],
      referencedTable: "bundles",
      referencedColumns: ["id"],
      onUpdate: "restrict",
      onDelete: "cascade",
    },
  ],
  relations: [
    {
      name: "bundle",
      fieldName: "patches",
      targetFieldName: "bundle",
      relationName: "bundle_patches_bundles_patches",
      columns: ["bundle_id"],
      referencedTable: "bundles",
      referencedColumns: ["id"],
    },
    {
      name: "baseBundle",
      fieldName: "baseForPatches",
      targetFieldName: "baseBundle",
      relationName: "bundle_patches_bundles_baseForPatches",
      columns: ["base_bundle_id"],
      referencedTable: "bundles",
      referencedColumns: ["id"],
    },
  ],
} as const satisfies HotUpdaterTableSchema;

const createSettingsTable = (
  version: HotUpdaterSchemaVersion,
): HotUpdaterTableSchema => ({
  ormName: HOT_UPDATER_SETTINGS_TABLE,
  internal: true,
  columns: [
    { ormName: "key", type: "varchar(255)", primaryKey: true },
    {
      ormName: "value",
      type: "string",
      default: { type: "literal", value: version },
    },
  ],
});

export const hotUpdaterSchemaVersions: readonly HotUpdaterVersionedSchema[] = [
  {
    version: "0.21.0",
    settingsTable: HOT_UPDATER_SETTINGS_TABLE,
    tables: [bundlesV021, createSettingsTable("0.21.0")],
  },
  {
    version: "0.29.0",
    settingsTable: HOT_UPDATER_SETTINGS_TABLE,
    tables: [bundlesV029, createSettingsTable("0.29.0")],
  },
  {
    version: "0.31.0",
    settingsTable: HOT_UPDATER_SETTINGS_TABLE,
    tables: [bundlesV031, bundlePatchesV031, createSettingsTable("0.31.0")],
  },
];
