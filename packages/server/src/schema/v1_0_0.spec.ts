import { describe, expect, it } from "vitest";

import { createTableSql } from "../db/schema/sql";
import {
  generateDrizzleSchema,
  generatePrismaSchema,
} from "../db/schemaGenerators";
import {
  bundleEventsV100,
  bundleInstallationsV100,
  bundlePatchesV100,
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
      "archive_byte_size",
      "metadata",
      "manifest_storage_uri",
      "manifest_file_hash",
      "asset_base_storage_uri",
    ]);
    expect(fields).not.toContain("channel_id");
    expect(fields).not.toContain("enabled");
    expect(fields).not.toContain("target_app_version");
  });

  it("stores required archive and patch sizes as bounded floating columns", () => {
    const archiveSize = bundlesV100.columns.find(
      ({ ormName }) => ormName === "archive_byte_size",
    );
    const patchSize = bundlePatchesV100.columns.find(
      ({ ormName }) => ormName === "byte_size",
    );
    const sql = createTableSql("postgresql").join("\n");
    const prisma = generatePrismaSchema("postgresql", v1_0_0);
    const drizzle = generateDrizzleSchema("postgresql", v1_0_0);

    expect(archiveSize?.type).toBe("float");
    expect(archiveSize?.nullable).toBeUndefined();
    expect(patchSize?.type).toBe("float");
    expect(patchSize?.nullable).toBeUndefined();
    expect(sql).toContain("archive_byte_size double precision not null");
    expect(sql).toContain("byte_size double precision not null");
    expect(sql).toContain("archive_byte_size <= 9007199254740991");
    expect(sql).toContain("byte_size <= 9007199254740991");
    expect(prisma).toContain("archive_byte_size Float");
    expect(prisma).toContain("byte_size Float");
    expect(drizzle).toContain(
      'archive_byte_size: doublePrecision("archive_byte_size").notNull()',
    );
    expect(drizzle).toContain(
      'byte_size: doublePrecision("byte_size").notNull()',
    );
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

  it("stores one current row per installation with the required lookup indexes", () => {
    expect(
      bundleInstallationsV100.columns.find(
        ({ ormName }) => ormName === "install_id",
      )?.primaryKey,
    ).toBe(true);
    expect(bundleInstallationsV100.indexes).toEqual([
      {
        columns: ["user_id", "install_id"],
        name: "bundle_installations_user_id_idx",
      },
      {
        columns: ["received_at_ms"],
        name: "bundle_installations_received_at_idx",
      },
    ]);

    const sql = createTableSql("postgresql").join("\n");
    const prisma = generatePrismaSchema("postgresql", v1_0_0);
    const drizzle = generateDrizzleSchema("postgresql", v1_0_0);
    expect(sql).toContain("create table bundle_installations");
    expect(sql).toContain("install_id varchar(255) primary key not null");
    expect(sql).toContain(
      "create index bundle_installations_user_id_idx on bundle_installations(user_id, install_id)",
    );
    expect(sql).toContain(
      "create index bundle_installations_received_at_idx on bundle_installations(received_at_ms)",
    );
    expect(prisma).toContain("model bundle_installations {");
    expect(prisma).toContain("install_id String @db.VarChar(255) @id");
    expect(drizzle).toContain("export const bundle_installations = pgTable(");
    expect(drizzle).toContain(
      'index("bundle_installations_user_id_idx").on(table.user_id, table.install_id)',
    );
  });

  it("keeps identity indexes valid on MySQL and MSSQL", () => {
    const mysql = createTableSql("mysql").join("\n");
    const mssql = createTableSql("mssql").join("\n");

    expect(mysql).toContain("install_id varchar(255) not null");
    expect(mysql).toContain("user_id varchar(255)");
    expect(mssql).toContain("install_id nvarchar(255) not null");
    expect(mssql).toContain("user_id nvarchar(255)");

    for (const sql of [mysql, mssql]) {
      expect(sql).toContain(
        "create index bundle_events_install_idx on bundle_events(install_id, type, received_at_ms, id)",
      );
      expect(sql).toContain(
        "create index bundle_installations_user_id_idx on bundle_installations(user_id, install_id)",
      );
    }
    expect(mssql).not.toContain("install_id nvarchar(max)");
    expect(mssql).not.toContain("user_id nvarchar(max)");
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
