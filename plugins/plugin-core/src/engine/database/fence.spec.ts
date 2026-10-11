import { DatabaseSync } from "node:sqlite";

import { sqliteExecutor } from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import type { DatabaseAdapter } from "../../database/adapter";
import { createMemoryAdapter } from "../../database/memoryAdapter";
import { migrateSchema, writeSchemaSettings } from "../db/schemaSettings";
import {
  checkSchemaFence,
  HotUpdaterSchemaMigrationRequiredError,
  isMissingSchemaError,
  SETTINGS_TABLE,
  withSchemaFence,
} from "./fence";
import { createSqlAdapter } from "./sql/sqlAdapter";

const settings = { "schema.engine": "1", "schema.core": "1.0.0" };

/** Counts the adapter's point reads. */
const counted = (adapter: DatabaseAdapter) => {
  const calls = { gets: 0 };
  return {
    calls,
    adapter: {
      ...adapter,
      get: (table, keys) => {
        calls.gets += 1;
        return adapter.get(table, keys);
      },
    } satisfies DatabaseAdapter,
  };
};

const mismatch = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) =>
      error instanceof HotUpdaterSchemaMigrationRequiredError
        ? error.setting
        : error,
  );

describe("schema fence", () => {
  it("passes once migrations wrote every setting, and names the first missing or different one", async () => {
    const memory = createMemoryAdapter();
    await expect(
      mismatch(checkSchemaFence(memory, "memory", settings)),
    ).resolves.toEqual({
      key: "schema.engine",
      expected: "1",
      found: null,
    });

    await migrateSchema(memory, "memory", [], settings);
    await expect(
      checkSchemaFence(memory, "memory", settings),
    ).resolves.toBeUndefined();
    await expect(
      mismatch(
        checkSchemaFence(memory, "memory", {
          ...settings,
          "schema.insights": "1.0.0",
        }),
      ),
    ).resolves.toEqual({
      key: "schema.insights",
      expected: "1.0.0",
      found: null,
    });
    await expect(
      mismatch(checkSchemaFence(memory, "memory", { "schema.core": "2.0.0" })),
    ).resolves.toEqual({
      key: "schema.core",
      expected: "2.0.0",
      found: "1.0.0",
    });
  });

  it("lists every plugin whose settings row is missing or stale, with the fix it is given", async () => {
    const memory = createMemoryAdapter();
    await migrateSchema(memory, "memory", [], {
      ...settings,
      "schema.notes": "1",
    });

    const error = await checkSchemaFence(
      memory,
      "memory",
      { "schema.insights": "2", "schema.notes": "2", "schema.keys": "1" },
      "Run the migration.",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HotUpdaterSchemaMigrationRequiredError);
    expect(error).toMatchObject({
      plugins: ["insights", "notes", "keys"],
      setting: { key: "schema.insights", expected: "2", found: null },
      message:
        'The tables of plugins "insights", "notes" and "keys" are not migrated on memory: schema settings "schema.insights" is missing; expected "2", and "schema.notes" is "1"; expected "2", and "schema.keys" is missing; expected "1". Run the migration.',
    });
    // Core's settings keep their own message, which names no plugin. An
    // unmigrated database only needs the migration.
    await expect(
      checkSchemaFence(createMemoryAdapter(), "memory", settings),
    ).rejects.toMatchObject({
      plugins: [],
      message:
        'Hot Updater schema setting "schema.engine" for memory is missing; expected "1". Run `hot-updater db migrate`.',
    });
  });

  it("asks for a new database only for a v0 schema, which it cannot migrate in place", () => {
    expect(
      new HotUpdaterSchemaMigrationRequiredError("memory", "0.21.0").message,
    ).toBe(
      "Hot Updater v1 cannot migrate schema 0.21.0 in place. Create a new empty database and run `hot-updater db migrate`.",
    );
  });

  it("checks before a process's first read only, and again after a failure", async () => {
    const memory = createMemoryAdapter();
    const { adapter, calls } = counted(memory);
    const fenced = withSchemaFence(adapter, "memory", settings);
    await expect(fenced.get(SETTINGS_TABLE, [["x"]])).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    await expect(fenced.get(SETTINGS_TABLE, [["x"]])).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    expect(calls.gets).toBe(2);

    await migrateSchema(memory, "memory", [], settings);
    calls.gets = 0;
    await fenced.get(SETTINGS_TABLE, [["x"]]);
    await fenced.get(SETTINGS_TABLE, [["x"]]);
    // one fence read, then the two reads themselves
    expect(calls.gets).toBe(3);
  });

  it("rewrites only changed settings", async () => {
    const memory = createMemoryAdapter();
    await migrateSchema(memory, "memory", [], settings);
    const writes: unknown[] = [];
    const recorded: DatabaseAdapter = {
      ...memory,
      write: (ops) => {
        writes.push(ops);
        return memory.write(ops);
      },
    };
    await writeSchemaSettings(recorded, "memory", settings);
    expect(writes).toEqual([]);
    await writeSchemaSettings(recorded, "memory", {
      ...settings,
      "schema.insights": "1.0.0",
    });
    expect(writes).toHaveLength(1);
  });
  it("reads a missing table as missing settings and rethrows any other failure", async () => {
    const empty = createSqlAdapter({
      executor: sqliteExecutor(new DatabaseSync(":memory:")),
    });
    await expect(
      mismatch(checkSchemaFence(empty, "sqlite", settings)),
    ).resolves.toEqual({ key: "schema.engine", expected: "1", found: null });

    const refused = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const offline: DatabaseAdapter = {
      ...createMemoryAdapter(),
      get: async () => {
        throw refused;
      },
    };
    await expect(checkSchemaFence(offline, "memory", settings)).rejects.toBe(
      refused,
    );
    await expect(migrateSchema(offline, "memory", [], settings)).rejects.toBe(
      refused,
    );
  });

  it.each([
    [
      "PostgreSQL",
      Object.assign(new Error('relation "x" does not exist'), {
        code: "42P01",
      }),
    ],
    [
      "MySQL",
      Object.assign(new Error("Table 'db.x' doesn't exist"), {
        code: "ER_NO_SUCH_TABLE",
      }),
    ],
    ["SQLite", new Error("SQLITE_ERROR: no such table: x")],
    [
      "an ORM wrapping the driver",
      new Error("Failed query", { cause: new Error("no such column: _v") }),
    ],
  ])("recognizes a missing table or column from %s", (_, error) => {
    expect(isMissingSchemaError(error)).toBe(true);
  });

  it("does not take a missing database or a driver failure for a missing table", () => {
    expect(isMissingSchemaError(new Error('database "x" does not exist'))).toBe(
      false,
    );
    expect(
      isMissingSchemaError(Object.assign(new Error("x"), { code: "28P01" })),
    ).toBe(false);
  });
});
