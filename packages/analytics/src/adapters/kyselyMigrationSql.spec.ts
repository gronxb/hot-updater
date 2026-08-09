import { describe, expect, it } from "vitest";

import {
  createAnalyticsV2Statements,
  KYSELY_ANALYTICS_DIALECTS,
  migrateAnalyticsV1Statements,
  type KyselyAnalyticsDialect,
} from "./kyselyMigrationSql";

const dialects = [
  "sqlite",
  "postgresql",
  "mysql",
] as const satisfies readonly KyselyAnalyticsDialect[];

describe("createAnalyticsV2Statements", () => {
  it("publishes the supported dialect set without MSSQL", () => {
    expect(KYSELY_ANALYTICS_DIALECTS).toEqual([
      "mysql",
      "postgresql",
      "sqlite",
    ]);
  });
  it.each(dialects)("creates an independent v2 schema for %s", (dialect) => {
    const statements = createAnalyticsV2Statements(dialect);
    const migration = statements.join("\n").toLowerCase();

    expect(migration).toContain("create table bundle_events");
    expect(migration).toContain("bundle_events_shape_v038_check");
    expect(migration).toContain("bundle_events_received_at_idx");
    expect(migration).not.toContain("references bundles");
    expect(migration).not.toContain("schema.analytics");
  });

  it("uses provider-native identifier and timestamp types", () => {
    expect(createAnalyticsV2Statements("sqlite")[0]).toContain(
      "received_at_ms real not null",
    );
    expect(createAnalyticsV2Statements("postgresql")[0]).toContain(
      "id uuid primary key not null",
    );
    expect(createAnalyticsV2Statements("mysql")[0]).toContain(
      "id char(36) primary key not null",
    );
  });
});

describe("migrateAnalyticsV1Statements", () => {
  it("rebuilds SQLite v1 without deleting event rows", () => {
    const statements = migrateAnalyticsV1Statements("sqlite");
    const migration = statements.join("\n").toLowerCase();

    expect(migration).toContain("insert into bundle_events_analytics_v2");
    expect(migration).toContain("select id, type, install_id");
    expect(migration).toContain("drop table bundle_events");
    expect(migration).toContain(
      "alter table bundle_events_analytics_v2 rename to bundle_events",
    );
    expect(migration.indexOf("insert into")).toBeLessThan(
      migration.indexOf("drop table"),
    );
  });

  it("makes PostgreSQL transition fields nullable before installing v2 checks", () => {
    const statements = migrateAnalyticsV1Statements("postgresql");
    const migration = statements.join("\n").toLowerCase();

    expect(migration).toContain("alter column from_bundle_id drop not null");
    expect(migration).toContain("alter column update_strategy drop not null");
    expect(migration).toContain("bundle_events_shape_v038_check");
  });

  it("uses MySQL check and nullability syntax", () => {
    const statements = migrateAnalyticsV1Statements("mysql");
    const migration = statements.join("\n").toLowerCase();

    expect(migration).toContain(
      "alter table bundle_events alter check bundle_events_type_check not enforced",
    );
    expect(migration).toContain("modify column from_bundle_id char(36) null");
    expect(migration).toContain("modify column update_strategy text null");
  });
});
