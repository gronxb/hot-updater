import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";
import { afterAll, describe, expect, it, vi } from "vitest";

import { HotUpdaterSchemaMigrationRequiredError } from "../db/schemaReadiness";
import { createHotUpdater } from "../index";
import {
  builtInSettings,
  createEngineDatabase,
  migrateBuiltInSchema,
} from "./builtInDatabase";
import {
  checkSchemaFence,
  isMissingSchemaError,
  migrateSchema,
  SETTINGS_TABLE,
  withSchemaFence,
  writeSchemaSettings,
} from "./fence";
import { createSqlAdapter } from "./sql/sqlAdapter";
import { pgliteExecutor, sqliteExecutor } from "./sql/sqlTestExecutors";

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

  it("rewrites only changed settings and refuses a database from before the engine", async () => {
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

    const legacy = createMemoryAdapter();
    await legacy.write([
      {
        type: "insert",
        table: SETTINGS_TABLE,
        row: { key: "schema.core", value: "1.0.0", _v: 0 },
      },
    ]);
    await expect(
      mismatch(writeSchemaSettings(legacy, "memory", settings)),
    ).resolves.toEqual({ key: "schema.engine", expected: "1", found: null });
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

describe("a provider's fenced database on PGlite", () => {
  const pglite = new PGlite();
  afterAll(() => pglite.close());

  it("answers 503 before migrations and serves after them", async () => {
    const adapter = createSqlAdapter({
      executor: pgliteExecutor(pglite),
      tablePrefix: "fence_",
    });
    const hotUpdater = createHotUpdater({
      database: createEngineDatabase({ name: "pglite", adapter }),
      clientAccess: "public",
    });
    const channels = () =>
      hotUpdater.handlers.admin(
        new Request("https://updates.example.com/channels"),
      );

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await channels()).status).toBe(503);
    error.mockRestore();
    await migrateBuiltInSchema(adapter, "pglite");
    await expect(
      checkSchemaFence(adapter, "pglite", builtInSettings),
    ).resolves.toBeUndefined();
    expect((await channels()).status).toBe(200);
    await expect(hotUpdater.core.listChannels()).resolves.toEqual([]);
  });
});
