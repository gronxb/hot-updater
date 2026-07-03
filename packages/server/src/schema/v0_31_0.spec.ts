import { describe, expect, it } from "vitest";

import { createTableStatement } from "../db/schema/sql";
import { bundlePatchesV031, v0_31_0 } from "./v0_31_0";

describe("bundlePatchesV031", () => {
  it("uses the functional schema DSL for the v0.31.0 bundle patches table", () => {
    expect(v0_31_0.dsl).toBe("schema");
    expect(bundlePatchesV031.dsl).toBe("table");
    expect(bundlePatchesV031.columns).toEqual([
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
    ]);
    expect(bundlePatchesV031.indexes).toEqual([
      { name: "bundle_patches_bundle_id_idx", columns: ["bundle_id"] },
      {
        name: "bundle_patches_base_bundle_id_idx",
        columns: ["base_bundle_id"],
      },
    ]);
    expect(bundlePatchesV031.foreignKeys).toEqual([
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
    ]);
    expect(bundlePatchesV031.relations).toEqual([
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
    ]);
    expect(Object.keys(bundlePatchesV031)).not.toContain("dsl");
    expect(createTableStatement(bundlePatchesV031, "postgresql")).toContain(
      "id varchar(255) primary key not null",
    );
  });
});

describe("v0_31_0 analytics tables", () => {
  it("defines canonical ingest key and analytics event tables", () => {
    const tables = new Map(
      v0_31_0.tables.map((table) => [table.ormName, table.columns]),
    );

    expect(tables.get("ingest_keys")).toEqual([
      { ormName: "id", type: "varchar(255)", primaryKey: true },
      { ormName: "key_hash", type: "string" },
      { ormName: "key_suffix", type: "string" },
      {
        ormName: "active",
        type: "bool",
        default: { type: "literal", value: true },
      },
      { ormName: "created_at", type: "string" },
      { ormName: "updated_at", type: "string" },
    ]);
    expect(tables.get("analytics_events")).toEqual([
      { ormName: "id", type: "varchar(255)", primaryKey: true },
      { ormName: "event_type", type: "string" },
      { ormName: "payload", type: "json" },
      { ormName: "observed_at", type: "string" },
      { ormName: "received_at", type: "string" },
    ]);
  });
});
