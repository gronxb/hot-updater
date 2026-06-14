import {
  column,
  foreignKey,
  idColumn,
  index,
  integer,
  relation,
  schema,
  table,
  uuid,
  varchar,
} from "./dsl";
import { createSettingsTable } from "./settings";
import {
  HOT_UPDATER_SETTINGS_TABLE,
  type HotUpdaterTableSchema,
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

export const v0_31_0 = schema({
  version: "0.31.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [bundlesV031, bundlePatchesV031, createSettingsTable("0.31.0")],
});
