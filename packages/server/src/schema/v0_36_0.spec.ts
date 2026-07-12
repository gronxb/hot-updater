import { describe, expect, it } from "vitest";

import { createMongoMigrationOperations } from "../db/schema/mongodb";
import { createSchemaMigrationSql } from "../db/schema/sqlMigrations";
import {
  generateDrizzleSchema,
  generatePrismaSchema,
} from "../db/schemaGenerators";
import {
  bundlePatchesV036,
  bundlesV036,
  channelsV036,
  v0_36_0,
} from "./v0_36_0";

describe("v0.36.0 schema", () => {
  it("defines channels and preserves every required foreign key", () => {
    expect(v0_36_0.version).toBe("0.36.0");
    expect(channelsV036.columns).toEqual([
      expect.objectContaining({ ormName: "id", primaryKey: true }),
    ]);
    expect(bundlesV036.foreignKeys).toEqual([
      expect.objectContaining({
        name: "bundles_channel_fk",
        onDelete: "restrict",
        referencedTable: "channels",
      }),
    ]);
    expect(bundlePatchesV036.foreignKeys).toEqual([
      expect.objectContaining({ name: "bundle_patches_bundle_id_fk" }),
      expect.objectContaining({ name: "bundle_patches_base_bundle_id_fk" }),
    ]);
  });

  it("orders the explicit channel backfill before the bundle constraint", () => {
    const statements = createSchemaMigrationSql(
      "0.31.0",
      "0.36.0",
      "postgresql",
    );
    const createChannelIndex = statements.findIndex((statement) =>
      statement.includes("create table if not exists channels"),
    );
    const backfillIndex = statements.findIndex((statement) =>
      statement.includes("select distinct channel from bundles"),
    );
    const constraintIndex = statements.findIndex((statement) =>
      statement.includes("add constraint bundles_channel_fk"),
    );

    expect(createChannelIndex).toBeGreaterThanOrEqual(0);
    expect(backfillIndex).toBeGreaterThan(createChannelIndex);
    expect(constraintIndex).toBeGreaterThan(backfillIndex);
    expect(statements[constraintIndex]).toContain("on delete restrict");
  });

  it("keeps relation metadata when physical foreign keys are disabled", () => {
    const statements = createSchemaMigrationSql(
      "0.31.0",
      "0.36.0",
      "postgresql",
      "fumadb",
    );
    const prisma = generatePrismaSchema("postgresql", v0_36_0);
    const drizzle = generateDrizzleSchema("postgresql", v0_36_0);

    expect(statements).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("add constraint bundles_channel_fk"),
      ]),
    );
    expect(prisma).toContain(
      'channelRef channels @relation("channels_bundles_channel"',
    );
    expect(prisma).toContain(
      'bundles bundles[] @relation("channels_bundles_channel")',
    );
    expect(prisma).toContain("onDelete: Restrict");
    expect(drizzle).toContain('name: "bundles_channel_fk"');
    expect(drizzle).toContain('.onDelete("restrict")');
    expect(drizzle).toContain("bundles: many(bundles");
  });

  it("orders MongoDB channel creation and backfill before the version write", () => {
    const operations = createMongoMigrationOperations({
      type: "custom",
      key: "version",
      value: "0.36.0",
    });
    const createChannelsIndex = operations.findIndex(
      (operation) =>
        operation.type === "create-table" &&
        operation.value.ormName === "channels",
    );
    const backfillIndex = operations.findIndex(
      (operation) =>
        operation.type === "custom" &&
        "sql" in operation &&
        operation.sql === "backfill channels from bundles.channel",
    );

    expect(createChannelsIndex).toBeGreaterThanOrEqual(0);
    expect(backfillIndex).toBeGreaterThan(createChannelsIndex);
    expect(backfillIndex).toBeLessThan(operations.length - 1);
  });
});
