import { describe, expect, it } from "vitest";

import { createTableSql } from "../db/schema/sql";
import {
  generateDrizzleSchema,
  generatePrismaSchema,
} from "../db/schemaGenerators";
import {
  bundleEventsV100,
  bundlesV100,
  releaseCatalogsV100,
  releasesV100,
  v1_0_0,
} from "./v1_0_0";

describe("v1.0.0 Release Catalog schema", () => {
  it("adds the canonical Release and catalog access paths", () => {
    expect(v1_0_0.tables.map(({ ormName }) => ormName)).toContain("releases");
    expect(v1_0_0.tables.map(({ ormName }) => ormName)).toContain(
      "release_catalogs",
    );
    expect(releasesV100.indexes).toContainEqual({
      columns: ["scope_key", "id"],
      name: "releases_scope_order_idx",
    });
    expect(
      releaseCatalogsV100.columns.find(({ ormName }) => ormName === "scope_key")
        ?.primaryKey,
    ).toBe(true);
  });

  it("keeps only immutable artifact fields on Bundle rows", () => {
    const fields = bundlesV100.columns.map(({ ormName }) => ormName);

    expect(fields).toEqual([
      "id",
      "platform",
      "file_hash",
      "git_commit_hash",
      "storage_uri",
      "metadata",
      "manifest_storage_uri",
      "manifest_file_hash",
      "asset_base_storage_uri",
    ]);
    expect(fields).not.toContain("channel_id");
    expect(fields).not.toContain("enabled");
    expect(fields).not.toContain("target_app_version");
  });

  it("keeps nullable sources while requiring the reported target Bundle", () => {
    for (const field of [
      "from_release_id",
      "to_release_id",
      "from_bundle_id",
    ]) {
      expect(
        bundleEventsV100.columns.find(({ ormName }) => ormName === field)
          ?.nullable,
      ).toBe(true);
    }
    expect(
      bundleEventsV100.columns.find(({ ormName }) => ormName === "to_bundle_id")
        ?.nullable,
    ).toBeUndefined();
  });

  it("generates nullable source and artifact relations with the intended deletion rules", () => {
    const prisma = generatePrismaSchema("postgresql", v1_0_0);
    const drizzle = generateDrizzleSchema("postgresql", v1_0_0);

    expect(prisma).toContain("model releases {");
    expect(prisma).toContain("sourceRelease releases? @relation(");
    expect(prisma).toContain("onDelete: SetNull");
    expect(prisma).toContain("bundle bundles? @relation(");
    expect(drizzle).toContain("export const release_catalogs = pgTable(");
    expect(drizzle).toContain('index("releases_scope_order_idx")');
    expect(drizzle).toContain("foreignColumns: [table.id]");
    expect(drizzle).not.toContain("foreignColumns: [releases.id]");
  });

  it("creates both projection tables and their constraints from empty", () => {
    const sql = createTableSql("postgresql").join("\n");

    expect(sql).toContain("create table releases");
    expect(sql).toContain("create table release_catalogs");
    expect(sql).toContain("releases_scope_order_idx");
    expect(sql).toContain("release_catalogs_generation_check");
    expect(sql).toContain("to_bundle_id uuid not null");
    expect(sql).toContain("from_bundle_id is not null");
    expect(sql).toContain("type = 'UNCHANGED' and from_bundle_id is null");
    expect(sql).toContain("on delete set null");
  });

  it("uses byte-bounded MySQL catalog keys", () => {
    const sql = createTableSql("mysql").join("\n");

    expect(sql).toContain(
      "scope_key varchar(2048) character set ascii collate ascii_bin",
    );
    expect(sql).toContain(
      "channel_key varchar(1400) character set ascii collate ascii_bin",
    );
    expect(sql).toContain(
      "create index releases_scope_order_idx on releases(scope_key, id)",
    );
    expect(sql).toContain("payload mediumtext not null");
    expect(generatePrismaSchema("mysql", v1_0_0)).toContain(
      "payload String @db.MediumText",
    );
    expect(generateDrizzleSchema("mysql", v1_0_0)).toContain(
      'payload: mediumtext("payload").notNull()',
    );
  });
});
