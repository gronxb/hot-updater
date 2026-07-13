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
      expect.objectContaining({ ormName: "name" }),
    ]);
    expect(channelsV036.indexes).toContainEqual({
      name: "channels_name_key",
      columns: ["name"],
      unique: true,
    });
    expect(bundlesV036.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ormName: "channel" }),
        expect.objectContaining({ ormName: "channel_id" }),
      ]),
    );
    expect(bundlesV036.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "bundles_channel_idx",
          columns: ["channel"],
        }),
        expect.objectContaining({
          name: "bundles_channel_id_idx",
          columns: ["channel_id"],
        }),
      ]),
    );
    expect(bundlesV036.foreignKeys).toEqual([
      expect.objectContaining({
        name: "bundles_channel_id_fk",
        columns: ["channel_id"],
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
    const backfillChannelsIndex = statements.findIndex((statement) =>
      statement.includes("select distinct channel, channel from bundles"),
    );
    const backfillBundlesIndex = statements.findIndex((statement) =>
      statement.includes("set channel_id = channels.id"),
    );
    const constraintIndex = statements.findIndex((statement) =>
      statement.includes("add constraint bundles_channel_id_fk"),
    );

    expect(createChannelIndex).toBeGreaterThanOrEqual(0);
    expect(backfillChannelsIndex).toBeGreaterThan(createChannelIndex);
    expect(backfillBundlesIndex).toBeGreaterThan(backfillChannelsIndex);
    expect(constraintIndex).toBeGreaterThan(backfillBundlesIndex);
    expect(statements).not.toEqual(
      expect.arrayContaining([expect.stringContaining("drop column channel")]),
    );
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
        expect.stringContaining("add constraint bundles_channel_id_fk"),
      ]),
    );
    expect(prisma).toContain(
      'channelRef channels @relation("channels_bundles_channel"',
    );
    expect(prisma).toContain("fields: [channel_id]");
    expect(prisma).toContain('channel String @default("production")');
    expect(prisma).toContain('@@index([channel], map: "bundles_channel_idx")');
    expect(prisma).toContain('@@unique([name], map: "channels_name_key")');
    expect(prisma).toContain(
      'bundles bundles[] @relation("channels_bundles_channel")',
    );
    expect(prisma).toContain("onDelete: Restrict");
    expect(drizzle).toContain('name: "bundles_channel_id_fk"');
    expect(drizzle).toContain(
      'channel: text("channel").notNull().default("production")',
    );
    expect(drizzle).toContain('index("bundles_channel_idx").on(table.channel)');
    expect(drizzle).toContain('.onDelete("restrict")');
    expect(drizzle).toContain(
      'uniqueIndex("channels_name_key").on(table.name)',
    );
    expect(drizzle).toContain("bundles: many(bundles");
  });

  it("uses the MySQL join update before requiring the normalized key", () => {
    const statements = createSchemaMigrationSql("0.31.0", "0.36.0", "mysql");

    expect(statements).toContain(
      "update bundles join channels on channels.name = bundles.channel set bundles.channel_id = channels.id",
    );
    expect(statements).toContain(
      "alter table bundles modify column channel_id varchar(255) not null",
    );
    expect(statements).not.toEqual(
      expect.arrayContaining([expect.stringContaining("drop column channel")]),
    );
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
        operation.sql ===
          "backfill channels(id, name) and bundles.channel_id from bundles.channel",
    );

    expect(createChannelsIndex).toBeGreaterThanOrEqual(0);
    expect(backfillIndex).toBeGreaterThan(createChannelsIndex);
    expect(backfillIndex).toBeLessThan(operations.length - 1);
    expect(operations).toContainEqual({
      type: "custom",
      sql: "create unique index channels_name_key on channels(name)",
    });
  });
});
