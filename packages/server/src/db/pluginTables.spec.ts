import { PGlite } from "@electric-sql/pglite";
import {
  HotUpdaterSchemaMigrationRequiredError,
  defineTable,
  createTableStatements,
  coreTarget,
  createEngineDatabase,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it, vi } from "vitest";

import { drizzleAdapter } from "../adapters/drizzle";
import { kyselyAdapter } from "../adapters/kysely";
import { prismaAdapter } from "../adapters/prisma";
import { createHotUpdater } from "../createHotUpdaterCore";
import { apiKeys } from "../plugins/api-keys";
import {
  type AnyHotUpdaterPlugin,
  definePlugin,
} from "../plugins/definePlugin";
import { insights } from "../plugins/insights";
import { createMigrator, generateSchema } from "./index";

const notes = definePlugin({
  id: "notes",
  schemaVersion: "2",
  schema: {
    notes: defineTable(
      {
        id: { type: "string" },
        author: { type: "string" },
        text: { type: "string" },
      },
      { key: ["id"], indexes: { byAuthor: { eq: ["author"], sort: ["id"] } } },
    ),
  },
  init: ({ db }) => ({
    api: {
      add: (id: string, author: string, text: string) =>
        db.transaction(async (tx) => {
          tx.create("notes", { id, author, text });
        }),
      read: (id: string) => db.findOne("notes", { id }),
    },
  }),
});

/** `hot-updater db migrate`: the migrator for the server's tables, run. */
const migrate = async (hotUpdater: { readonly adapterName: string }) => {
  const result = await createMigrator(hotUpdater).migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });
  await result.execute();
  return result;
};

const memoryDatabase = () =>
  createEngineDatabase({ name: "memory", adapter: createMemoryAdapter() });

describe("plugin tables in db tooling", () => {
  it("adds each plugin's tables and settings row to core's, prefixed by its id unless it keeps its names", () => {
    expect(toolingTargetOf([])).toBe(coreTarget);
    const target = toolingTargetOf([insights(), notes]);
    const names = target.schema.tables.map(({ name }) => name);
    expect(names.slice(0, coreTarget.schema.tables.length)).toEqual(
      coreTarget.schema.tables.map(({ name }) => name),
    );
    expect(names).toContain("bundle_events");
    expect(names.at(-1)).toBe("notes_notes");
    expect(target.settings).toEqual({
      ...coreTarget.settings,
      "schema.insights": insights().schemaVersion,
      "schema.notes": "2",
    });
  });

  it("fits Hot Updater's own plugins' tables within MySQL's key limit", () => {
    expect(() =>
      createTableStatements(
        "mysql",
        toolingTargetOf([insights(), apiKeys()]).schema.tables,
      ),
    ).not.toThrow();
  });

  it("migrates an engine database's core and plugin tables with its adapter", async () => {
    const hotUpdater = createHotUpdater({
      database: memoryDatabase(),
      plugins: [notes],
      clientAccess: "public",
    });
    await expect(hotUpdater.api.notes.read("n1")).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );

    const result = await migrate(hotUpdater);
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        type: "create-table",
        value: expect.objectContaining({ ormName: "notes_notes" }),
      }),
    );
    await hotUpdater.api.notes.add("n1", "ada", "hello");
    await expect(hotUpdater.api.notes.read("n1")).resolves.toEqual({
      id: "n1",
      author: "ada",
      text: "hello",
    });
    await expect(hotUpdater.core.listChannels()).resolves.toEqual([]);
  });

  it("answers 503 until the plugin's settings row exists, then serves it", async () => {
    const database = memoryDatabase();
    await migrate(createHotUpdater({ database, clientAccess: "public" }));
    const hotUpdater = createHotUpdater({
      database,
      plugins: [notes],
      clientAccess: "public",
    });
    await expect(hotUpdater.api.notes.read("n1")).rejects.toThrow(
      'Hot Updater schema setting "schema.notes" for memory is missing; expected "2". Run `hot-updater db migrate`.',
    );
    await expect(hotUpdater.core.listChannels()).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    const channels = () =>
      hotUpdater.handlers.admin(new Request("http://localhost/channels"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await channels()).status).toBe(503);
    error.mockRestore();

    await migrate(hotUpdater);
    expect((await channels()).status).toBe(200);
    await expect(hotUpdater.api.notes.read("n1")).resolves.toBeNull();
    // The server without the plugin was already served.
    await expect(
      createHotUpdater({
        database,
        clientAccess: "public",
      }).core.listChannels(),
    ).resolves.toEqual([]);
  });

  it("writes a Kysely migration of the plugin's tables and settings row", async () => {
    const db = new PGlite();
    const kysely = new Kysely<object>({ dialect: new PGliteDialect(db) });
    try {
      const hotUpdater = createHotUpdater({
        database: kyselyAdapter({ db: kysely, provider: "postgresql" }),
        plugins: [notes],
        clientAccess: "public",
      });
      const result = await createMigrator(hotUpdater).migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      });
      const sql = result.getSQL?.() ?? "";
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "notes_notes"');
      expect(sql).toContain(
        'CREATE INDEX IF NOT EXISTS "notes_notes_byAuthor" ON "notes_notes" ("author", "id")',
      );
      expect(sql).toContain("VALUES ('schema.notes', '2', 0)");

      await result.execute();
      await hotUpdater.api.notes.add("n1", "ada", "hello");
      await expect(hotUpdater.api.notes.read("n1")).resolves.toMatchObject({
        text: "hello",
      });
    } finally {
      await kysely.destroy();
      await db.close();
    }
  });

  it("generates Drizzle and Prisma schemas with the plugin's tables", () => {
    const generated = (
      database: Parameters<typeof createHotUpdater>[0]["database"],
    ) =>
      generateSchema(
        createHotUpdater({
          database,
          plugins: [notes],
          clientAccess: "public",
        }),
        "latest",
      ).code;

    expect(
      generated(drizzleAdapter({ db: {}, provider: "postgresql" })),
    ).toContain('pgTable("notes_notes"');
    expect(
      generated(prismaAdapter({ prisma: {}, provider: "postgresql" })),
    ).toContain("model notes_notes {");
  });

  it("checks a plugin's id and tables against core, the other plugins the server runs, and Hot Updater's own ids", () => {
    const named = definePlugin({
      id: "insights",
      schemaVersion: "1",
      schema: {
        notes: defineTable({ id: { type: "string" } }, { key: ["id"] }),
      },
      init: () => ({ api: {} }),
    });
    const tabled = definePlugin({
      id: "api",
      schemaVersion: "1",
      schema: {
        keys: defineTable({ id: { type: "string" } }, { key: ["id"] }),
      },
      init: () => ({ api: {} }),
    });
    const unprefixed = definePlugin({
      id: "shadowCore",
      namespace: false,
      schemaVersion: "1",
      schema: {
        channels: defineTable({ id: { type: "string" } }, { key: ["id"] }),
      },
      init: () => ({ api: {} }),
    });
    const start = (plugins: readonly AnyHotUpdaterPlugin[]) => () =>
      createHotUpdater({
        database: memoryDatabase(),
        plugins,
        ...(plugins.some(({ provides }) => provides?.clientAuth)
          ? {}
          : { clientAccess: "public" }),
      } as Parameters<typeof createHotUpdater>[0]);

    // Only Hot Updater's own plugins take their ids, even when absent;
    // a copy of one loses the factory's mark.
    expect(start([named])).toThrow(
      "which is reserved for Hot Updater's insights() plugin",
    );
    expect(start([{ ...insights() }])).toThrow(
      "which is reserved for Hot Updater's insights() plugin",
    );
    expect(start([insights(), apiKeys()])).not.toThrow();
    // Only the plugins a server runs get tables, so this fits on its own.
    expect(start([tabled])).not.toThrow();
    expect(start([tabled, apiKeys()])).toThrow(
      'apiKeys.api_keys: table "api_keys" is also declared by api.keys',
    );
    expect(start([unprefixed])).toThrow(
      'shadowCore.channels: table "channels" is also declared by core.channels',
    );
  });
});
