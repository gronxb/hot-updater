import { createSettingsTable } from "./settings";
import {
  HOT_UPDATER_SETTINGS_TABLE,
  type HotUpdaterTableSchema,
  type HotUpdaterVersionedSchema,
} from "./types";
import { bundlesV029 } from "./v0_29_0";

export const bundlesV031 = {
  ...bundlesV029,
  columns: [
    ...bundlesV029.columns,
    { ormName: "manifest_storage_uri", type: "string", nullable: true },
    { ormName: "manifest_file_hash", type: "string", nullable: true },
    { ormName: "asset_base_storage_uri", type: "string", nullable: true },
  ],
} as const satisfies HotUpdaterTableSchema;

export const bundlePatchesV031 = {
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

export const v0_31_0 = {
  version: "0.31.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [bundlesV031, bundlePatchesV031, createSettingsTable("0.31.0")],
} as const satisfies HotUpdaterVersionedSchema;
