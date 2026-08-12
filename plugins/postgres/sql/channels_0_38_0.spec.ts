import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("PostgreSQL channel migration", () => {
  let db: PGlite;
  let migration: string;

  beforeEach(async () => {
    db = new PGlite();
    migration = await fs.readFile(
      path.resolve("plugins/postgres/sql/channels_0_38_0.sql"),
      "utf8",
    );
    await db.exec(`
      CREATE TABLE bundles (
        id uuid PRIMARY KEY,
        channel text NOT NULL DEFAULT 'production'
      );
      INSERT INTO bundles (id, channel) VALUES
        ('00000000-0000-0000-0000-000000000001', 'production'),
        ('00000000-0000-0000-0000-000000000002', 'production'),
        ('00000000-0000-0000-0000-000000000003', 'staging');
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  it("backfills one stable channel row per legacy name", async () => {
    await db.exec(migration);

    const channels = await db.query<{ id: string; name: string }>(`
      SELECT id, name FROM channels ORDER BY name ASC
    `);
    expect(channels.rows).toEqual([
      { id: expect.any(String), name: "production" },
      { id: expect.any(String), name: "staging" },
    ]);

    const bundles = await db.query<{
      channel: string;
      channel_id: string;
      channel_name: string;
    }>(`
      SELECT bundles.channel, bundles.channel_id, channels.name AS channel_name
      FROM bundles
      JOIN channels ON channels.id = bundles.channel_id
      ORDER BY bundles.id ASC
    `);
    expect(bundles.rows).toHaveLength(3);
    expect(bundles.rows.every((row) => row.channel === row.channel_name)).toBe(
      true,
    );

    const originalIds = channels.rows.map(({ id }) => id);
    await db.exec(migration);
    const rerun = await db.query<{ id: string }>(`
      SELECT id FROM channels ORDER BY name ASC
    `);
    expect(rerun.rows.map(({ id }) => id)).toEqual(originalIds);
  });

  it("enforces non-null and valid channel references", async () => {
    await db.exec(migration);

    await expect(
      db.exec(`
        INSERT INTO bundles (id, channel, channel_id)
        VALUES (
          '00000000-0000-0000-0000-000000000004',
          'production',
          '00000000-0000-0000-0000-999999999999'
        );
      `),
    ).rejects.toThrow();

    await expect(
      db.exec(`
        INSERT INTO bundles (id, channel, channel_id)
        VALUES (
          '00000000-0000-0000-0000-000000000005',
          'production',
          NULL
        );
      `),
    ).rejects.toThrow();
  });
});
