import { PGlite } from "@electric-sql/pglite";
import {
  HotUpdaterSchemaMigrationRequiredError,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neonDatabase } from "./neonDatabase";
import { pgliteNeon } from "./neonDriver.testFixtures";
import { neonExecutor } from "./neonExecutor";

const state = vi.hoisted(() => ({
  db: undefined as PGlite | undefined,
  calls: [] as unknown[][],
}));

vi.mock("@neondatabase/serverless", async () => {
  const { pgliteNeon } = await import("./neonDriver.testFixtures");
  return {
    neon: (...args: unknown[]) => {
      state.calls.push(args);
      return pgliteNeon(state.db!);
    },
  };
});

const connectionString = "postgresql://user:password@ep-test.neon.tech/db";

let db: PGlite;

beforeEach(() => {
  db = new PGlite();
  state.db = db;
  state.calls = [];
});

afterEach(async () => {
  state.db = undefined;
  await db.close();
});

describe("neonDatabase", () => {
  it("asks the driver for full results on the given connection string", () => {
    neonDatabase({ connectionString });

    expect(state.calls).toEqual([[connectionString, { fullResults: true }]]);
  });

  it("refuses an empty branch, then serves once `db migrate` creates its tables and the write guard", async () => {
    const database = neonDatabase({ connectionString });
    const { core } = createHotUpdater({
      database,
      storage: createReleaseCatalogTestStorage(),
      plugins: [insights()],
      clientAccess: "public",
    });

    await expect(core.listChannels()).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );

    const migrator = database.createMigrator!(toolingTargetOf([insights()]));
    await (await migrator.migrateToLatest()).execute();

    await expect(core.listChannels()).resolves.toEqual([]);
    const tables = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE tablename IN ('_hu_write', 'private_hot_updater_settings') ORDER BY tablename",
    );
    expect(tables.rows.map(({ tablename }) => tablename)).toEqual([
      "_hu_write",
      "private_hot_updater_settings",
    ]);
    // The batch removes its guard row before it commits.
    expect((await db.query("SELECT * FROM _hu_write")).rows).toEqual([]);
  });
});

describe("neonExecutor", () => {
  it("counts the rows a write changed, not the rows a SELECT returned", async () => {
    const executor = neonExecutor(pgliteNeon(db));
    await db.exec("CREATE TABLE t (id int PRIMARY KEY)");

    const inserted = await executor.execute({
      sql: "INSERT INTO t (id) VALUES ($1), ($2)",
      params: [1, 2],
    });
    const selected = await executor.execute({
      sql: "SELECT id FROM t ORDER BY id",
      params: [],
    });

    expect(inserted).toEqual({ rows: [], changes: 2 });
    expect(selected).toEqual({ rows: [{ id: 1 }, { id: 2 }], changes: 0 });
  });

  it("runs a batch in one transaction and keeps the failing statement's SQLSTATE", async () => {
    const executor = neonExecutor(pgliteNeon(db));
    await db.exec("CREATE TABLE t (id int PRIMARY KEY)");

    await expect(
      executor.batch!([
        { sql: "INSERT INTO t (id) VALUES ($1)", params: [1] },
        { sql: "INSERT INTO t (id) VALUES ($1)", params: [1] },
      ]),
    ).rejects.toMatchObject({ code: "23505" });
    expect((await db.query("SELECT * FROM t")).rows).toEqual([]);
  });

  it("has no interactive transactions", () => {
    const executor = neonExecutor(pgliteNeon(db));

    expect(() => executor.transaction(async () => undefined)).toThrow(
      "no interactive transactions",
    );
  });
});
