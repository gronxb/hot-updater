import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SqliteValue } from "node:sqlite";

import {
  toolingTargetOf,
  HotUpdaterSchemaMigrationRequiredError,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { createBundleFixture } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createD1Database } from "./d1Executor";
import { d1SchemaSql } from "./d1Schema";
import { plugins } from "./plugins";

/** The managed Worker's migration: core's tables and its plugins'. */
const managedSql = () => d1SchemaSql(toolingTargetOf(plugins));

const FILES = [
  "plugins/cloudflare/sql/bundles.sql",
  "plugins/cloudflare/worker/migrations/0002_hot-updater_1.0.0-rc.30.sql",
].map((file) => path.resolve(file));

/** D1's API over `node:sqlite`: statements one at a time, batches in one transaction. */
const sqliteD1 = (db: DatabaseSync) => {
  const run = (sql: string, params: readonly unknown[]) => {
    const statement = db.prepare(sql);
    const values = params as SqliteValue[];
    return statement.columns().length > 0
      ? { rows: statement.all(...values), changes: 0 }
      : { rows: [], changes: Number(statement.run(...values).changes) };
  };
  return createD1Database({
    query: async ({ sql, params }) => run(sql, params),
    batch: async (batch) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = batch.map(({ sql, params }) => run(sql, params));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  });
};

describe("d1 schema", () => {
  it("checks in exactly the generated schema as the SQL file and the latest additive migration", async () => {
    if (process.env.HOT_UPDATER_UPDATE_SQL === "1") {
      for (const file of FILES) await fs.writeFile(file, managedSql());
    }
    // Regenerate with HOT_UPDATER_UPDATE_SQL=1 after the schema changes.
    for (const file of FILES) {
      expect(await fs.readFile(file, "utf8")).toBe(managedSql());
    }
  });

  it("serves once the schema is applied, writing each change as one batch", async () => {
    const db = new DatabaseSync(":memory:");
    const core = createHotUpdater({
      database: sqliteD1(db),
      clientAccess: "public",
    }).core;
    await expect(core.listChannels()).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    db.exec(
      await fs.readFile(
        "plugins/cloudflare/worker/migrations/0001_hot-updater_1.0.0.sql",
        "utf8",
      ),
    );
    const [deployed] = await core.deploy([
      {
        bundle: createBundleFixture("1"),
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.0",
        },
      },
    ]);
    // Upgrade a populated old schema without losing the deployed release.
    db.exec(await fs.readFile(FILES[1]!, "utf8"));
    expect(
      db
        .prepare("SELECT value FROM private_hot_updater_settings WHERE key = ?")
        .get("schema.insights"),
    ).toMatchObject({ value: "1.3.0" });
    await expect(core.getRelease(deployed!.release!.id)).resolves.toEqual(
      deployed!.release,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM _hu_write").all()).toEqual([
      { n: 0 },
    ]);
    db.close();
  });
});
