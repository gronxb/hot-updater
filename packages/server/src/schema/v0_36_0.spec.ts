import { describe, expect, it } from "vitest";

import { createMongoMigrationOperations } from "../db/schema/mongodb";
import { createSchemaMigrationSql } from "../db/schema/sqlMigrations";
import {
  generateDrizzleSchema,
  generatePrismaSchema,
} from "../db/schemaGenerators";
import { bundlePatchesV036, bundlesV036, v0_36_0 } from "./v0_36_0";

describe("v0.36.0 schema", () => {
  it("keeps channel names directly on bundles", () => {
    expect(v0_36_0.version).toBe("0.36.0");
    expect(v0_36_0.tables.map(({ ormName }) => ormName)).toEqual([
      "bundles",
      "bundle_patches",
      "private_hot_updater_settings",
    ]);
    expect(bundlesV036.columns).toContainEqual(
      expect.objectContaining({ ormName: "channel" }),
    );
    expect(bundlesV036.indexes).toContainEqual(
      expect.objectContaining({
        name: "bundles_channel_idx",
        columns: ["channel"],
      }),
    );
    expect(bundlePatchesV036.foreignKeys).toEqual([
      expect.objectContaining({ name: "bundle_patches_bundle_id_fk" }),
      expect.objectContaining({ name: "bundle_patches_base_bundle_id_fk" }),
    ]);
  });

  it.each(["postgresql", "mysql", "sqlite"] as const)(
    "does not add schema objects for %s",
    (provider) => {
      expect(createSchemaMigrationSql("0.31.0", "0.36.0", provider)).toEqual(
        [],
      );
    },
  );

  it("generates ORM schemas with a direct channel field", () => {
    const prisma = generatePrismaSchema("postgresql", v0_36_0);
    const drizzle = generateDrizzleSchema("postgresql", v0_36_0);

    expect(prisma).toContain('channel String @default("production")');
    expect(prisma).toContain('@@index([channel], map: "bundles_channel_idx")');
    expect(drizzle).toContain(
      'channel: text("channel").notNull().default("production")',
    );
    expect(drizzle).toContain('index("bundles_channel_idx").on(table.channel)');
  });

  it("does not emit a MongoDB channel backfill operation", () => {
    const operations = createMongoMigrationOperations({
      type: "custom",
      key: "version",
      value: "0.36.0",
    });

    expect(operations.at(-1)).toEqual({
      type: "custom",
      key: "version",
      value: "0.36.0",
    });
    expect(operations).not.toContainEqual(
      expect.objectContaining({ sql: expect.stringContaining("backfill") }),
    );
  });
});
