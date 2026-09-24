import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SqliteValue } from "node:sqlite";

import {
  builtInSchema,
  builtInSettings,
  createTableStatements,
  WRITE_GUARD_TABLE,
} from "@hot-updater/server/database";
import {
  createDatabaseCoreApi,
  generateEngineSql,
  HotUpdaterSchemaMigrationRequiredError,
} from "@hot-updater/server/db";
import { describe, expect, it } from "vitest";

import { createBundleFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createD1Database } from "./d1Executor";

const FILES = [
  "plugins/cloudflare/sql/bundles.sql",
  "plugins/cloudflare/worker/migrations/0001_hot-updater_1.0.0.sql",
].map((file) => path.resolve(file));

/** D1's schema: the guard table batch writes need, then the shared SQL schema, settings last. */
const statements = () => [
  ...createTableStatements("sqlite", [WRITE_GUARD_TABLE]),
  ...generateEngineSql("sqlite", builtInSchema, builtInSettings),
];
const expectedSql = () =>
  `-- HotUpdater.schema\n\n${statements()
    .map((statement) => `${statement};`)
    .join("\n\n")}\n`;

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
  it("checks in exactly the generated schema as the SQL file and the first migration", async () => {
    if (process.env.HOT_UPDATER_UPDATE_SQL === "1") {
      for (const file of FILES) await fs.writeFile(file, expectedSql());
    }
    // Regenerate with HOT_UPDATER_UPDATE_SQL=1 after the schema changes.
    for (const file of FILES) {
      expect(await fs.readFile(file, "utf8")).toBe(expectedSql());
    }
  });

  it("serves once the schema is applied, writing each change as one batch", async () => {
    const db = new DatabaseSync(":memory:");
    const core = createDatabaseCoreApi(sqliteD1(db));
    await expect(core.listChannels()).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    for (const statement of statements()) db.exec(statement);
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
    await expect(core.getRelease(deployed!.release!.id)).resolves.toEqual(
      deployed!.release,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM _hu_write").all()).toEqual([
      { n: 0 },
    ]);
    db.close();
  });
});
