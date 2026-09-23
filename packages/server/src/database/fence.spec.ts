import { PGlite } from "@electric-sql/pglite";
import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";
import { afterAll, describe, expect, it } from "vitest";

import { HotUpdaterSchemaMigrationRequiredError } from "../db/schemaReadiness";
import { createHotUpdater } from "../index";
import {
  checkSchemaFence,
  migrateSchema,
  SETTINGS_TABLE,
  withSchemaFence,
  writeSchemaSettings,
} from "./fence";
import {
  createLegacyDatabasePlugin,
  legacyFacadeSettings,
  migrateLegacyFacade,
} from "./legacyFacade";
import { createSqlAdapter } from "./sql/sqlAdapter";
import { pgliteExecutor } from "./sql/sqlTestExecutors";

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
});

describe("the fenced façade on PGlite", () => {
  const pglite = new PGlite();
  afterAll(() => pglite.close());

  it("answers 503 before migrations and serves after them", async () => {
    const adapter = createSqlAdapter({
      executor: pgliteExecutor(pglite),
      tablePrefix: "fence_",
    });
    const database = createLegacyDatabasePlugin({
      name: "pglite",
      adapter,
      fence: true,
    });
    const hotUpdater = createHotUpdater({
      database,
      clientAccess: { type: "public" },
    });
    const channels = () =>
      hotUpdater.handlers.admin(
        new Request("https://updates.example.com/channels"),
      );

    expect((await channels()).status).toBe(503);
    await migrateLegacyFacade(adapter, "pglite");
    await expect(
      checkSchemaFence(adapter, "pglite", legacyFacadeSettings),
    ).resolves.toBeUndefined();
    expect((await channels()).status).toBe(200);
    await expect(database.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
  });
});
