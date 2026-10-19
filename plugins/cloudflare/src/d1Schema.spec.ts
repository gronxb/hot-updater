import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SqliteValue } from "node:sqlite";

import {
  definePlugin,
  defineTable,
  toolingTargetOf,
  HotUpdaterSchemaMigrationRequiredError,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";
import {
  createBundleFixture,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createD1Database } from "./d1Executor";
import {
  d1MigrationSql,
  d1MigrationStatements,
  d1SchemaSql,
  d1SchemaStatements,
} from "./d1Schema";

/**
 * The managed database's schema: core's tables, and those of the plugins the
 * managed Worker runs. An official plugin that only the CLI and console run
 * joins this list, not the Worker's.
 */
const managed = toolingTargetOf([insights(), apiKeys(), remoteConfig()]);

const SCHEMA_FILE = path.resolve("plugins/cloudflare/sql/bundles.sql");
const MIGRATIONS = path.resolve("plugins/cloudflare/worker/migrations");

/**
 * The migrations a release shipped, by their SHA-256: installed databases ran
 * them, so they never change. When `LATEST` ships, move it here and name the
 * next release's migration `LATEST`.
 */
const SHIPPED: Readonly<Record<string, string>> = {
  "0001_hot-updater_1.0.0.sql":
    "ed96ee68fe1511d77fcec2cdd704389a68f13976814467b45a07fbfae4b3612f",
};

/**
 * The migration the next release ships, regenerated with
 * HOT_UPDATER_UPDATE_SQL=1 after the managed schema changes: what the
 * shipped migrations do not create yet, then every settings row. `hot-updater
 * doctor --fix` applies it to a database an earlier release initialized.
 */
const LATEST = "0002_hot-updater_1.2.0.sql";

const readMigration = (name: string) =>
  fs.readFile(path.join(MIGRATIONS, name), "utf8");

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

/** Every table, index, and settings row of a database. */
const describeSchema = (db: DatabaseSync) => ({
  objects: db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all(),
  settings: db
    .prepare("SELECT key, value FROM private_hot_updater_settings ORDER BY key")
    .all(),
});

describe("d1 schema", () => {
  it("checks in the generated schema, the shipped migrations unchanged, and the next one generated", async () => {
    const shipped = await Promise.all(
      Object.keys(SHIPPED).map((name) => readMigration(name)),
    );
    if (process.env.HOT_UPDATER_UPDATE_SQL === "1") {
      await fs.writeFile(SCHEMA_FILE, d1SchemaSql(managed));
      await fs.writeFile(
        path.join(MIGRATIONS, LATEST),
        d1MigrationSql(managed, shipped),
      );
    }
    expect((await fs.readdir(MIGRATIONS)).sort()).toEqual([
      ...Object.keys(SHIPPED),
      LATEST,
    ]);
    expect(
      shipped.map((sql) => createHash("sha256").update(sql).digest("hex")),
    ).toEqual(Object.values(SHIPPED));
    // Regenerate with HOT_UPDATER_UPDATE_SQL=1 after the schema changes.
    expect(await fs.readFile(SCHEMA_FILE, "utf8")).toBe(d1SchemaSql(managed));
    expect(await readMigration(LATEST)).toBe(d1MigrationSql(managed, shipped));
  });

  it("creates the managed schema from the migrations in order, as from the schema file", async () => {
    const migrated = new DatabaseSync(":memory:");
    for (const name of [...Object.keys(SHIPPED), LATEST]) {
      for (const statement of d1MigrationStatements(
        await readMigration(name),
      )) {
        migrated.exec(statement);
      }
    }
    const created = new DatabaseSync(":memory:");
    created.exec(d1SchemaSql(managed));
    expect(describeSchema(migrated)).toEqual(describeSchema(created));
    migrated.close();
    created.close();
  });

  it("writes into a later migration only what the earlier ones did not create, and every settings row", () => {
    const later = toolingTargetOf([
      insights(),
      apiKeys(),
      remoteConfig(),
      definePlugin({
        id: "audit",
        schemaVersion: "1",
        schema: {
          entries: defineTable({ id: { type: "string" } }, { key: ["id"] }),
        },
        init: () => ({ api: {} }),
      }),
    ]);
    const statements = d1MigrationStatements(
      d1MigrationSql(later, [d1SchemaSql(managed)]),
    );
    expect(statements.filter((sql) => sql.startsWith("CREATE"))).toEqual([
      'CREATE TABLE IF NOT EXISTS "audit_entries" ("id" TEXT NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"))',
    ]);
    expect(
      statements
        .filter((sql) => sql.startsWith("INSERT"))
        .map((sql) => sql.match(/VALUES \('([^']+)'/u)?.[1]),
    ).toEqual(Object.keys(later.settings));
  });

  it("serves once the schema is applied, writing each change as one batch", async () => {
    const db = new DatabaseSync(":memory:");
    const core = createHotUpdater({
      database: sqliteD1(db),
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    }).core;
    await expect(core.listChannels()).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    for (const statement of d1SchemaStatements()) db.exec(statement);
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
