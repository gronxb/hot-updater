import { PGlite } from "@electric-sql/pglite";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it, vi } from "vitest";

import { drizzleAdapter } from "../adapters/drizzle";
import { kyselyAdapter } from "../adapters/kysely";
import { prismaAdapter } from "../adapters/prisma";
import { createHotUpdater } from "../createHotUpdaterCore";
import {
  builtInTarget,
  createEngineDatabase,
  toolingTargetOf,
} from "../database/builtInDatabase";
import { HotUpdaterSchemaMigrationRequiredError } from "../database/fence";
import { defineTable } from "../database/schema";
import { definePlugin } from "../plugins/definePlugin";
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

describe("third-party plugin tables in db tooling", () => {
  it("adds each third-party plugin's namespaced tables and settings row to the built-in ones", () => {
    expect(toolingTargetOf([insights()])).toBe(builtInTarget);
    const target = toolingTargetOf([insights(), notes]);
    expect(target.schema.tables.map(({ name }) => name)).toEqual([
      ...builtInTarget.schema.tables.map(({ name }) => name),
      "notes_notes",
    ]);
    expect(target.settings).toEqual({
      ...builtInTarget.settings,
      "schema.notes": "2",
    });
  });

  it("migrates an engine database's built-in and plugin tables with its adapter", async () => {
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

  it("rejects a third-party plugin that takes a built-in plugin's id or table", () => {
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

    expect(() =>
      createHotUpdater({
        database: memoryDatabase(),
        plugins: [named],
        clientAccess: "public",
      }),
    ).toThrow(`Plugin "insights" uses a built-in plugin's id.`);
    expect(() =>
      createHotUpdater({
        database: memoryDatabase(),
        plugins: [tabled],
        clientAccess: "public",
      }),
    ).toThrow(
      'api.keys: table "api_keys" is also declared by apiKeys.api_keys',
    );
  });
});
