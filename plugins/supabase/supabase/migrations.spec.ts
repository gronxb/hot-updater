import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { createMigrator, generateSchema } from "@hot-updater/cli-tools";
import {
  toolingTargetOf,
  definePlugin,
  defineTable,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  apiKeys,
  createInsightsModel,
  insights,
  remoteConfig,
} from "@hot-updater/server/plugins";
import {
  setupDatabaseTestSuite,
  startHttpTestServer,
  insightsTestSuite,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { supabaseDatabase } from "../src/supabaseDatabase";
import { toApplyStatement } from "../src/supabaseExecutor";
import { supabaseDatabase as supabaseToolingDatabase } from "../src/supabaseMigration";
import {
  SUPABASE_APPLY_FUNCTION,
  SUPABASE_SETTINGS_TABLE,
  supabaseMigrationSql,
  supabaseMigrationStatements,
  supabaseSchemaSql,
  supabaseTableNames,
} from "../src/supabaseSchema";

const MIGRATIONS = path.resolve("plugins/supabase/supabase/migrations");

/**
 * The managed database's schema: core's tables, and those of the plugins the
 * managed Edge Function runs (Insights, API keys, and Remote Config). An
 * official plugin that only the CLI and console run joins this list, not the
 * function's.
 */
const managed = toolingTargetOf([insights(), apiKeys(), remoteConfig()]);

/**
 * The migrations a release shipped, by their SHA-256: installed databases ran
 * them, so they never change. When `LATEST` ships, move it here and name the
 * next release's migration `LATEST`.
 */
const SHIPPED: Readonly<Record<string, string>> = {
  "0001_hot-updater_1.0.0.sql":
    "4d58fe718d49c6b47e6e7233fdef37e6ab0b0e86a407c3b47af2c097d9d9673b",
};

/**
 * The migration the next release ships, regenerated with
 * HOT_UPDATER_UPDATE_SQL=1 after the managed schema changes: what the
 * shipped migrations do not create yet, with the apply RPC and its grants
 * again when it names a new table, then every settings row. `hot-updater
 * doctor --fix` applies it to a project an earlier release initialized.
 */
const LATEST = "0002_hot-updater_1.2.0.sql";

const readMigration = (name: string) =>
  fs.readFile(path.join(MIGRATIONS, name), "utf8");

const state = vi.hoisted(() => ({ db: undefined as PGlite | undefined }));

/** Supabase's client, as PostgREST runs an RPC: one statement, as the service role. */
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: { readonly p_statements: unknown }) => {
      try {
        const result = await state.db!.query<{ result: unknown }>(
          `SELECT public.${name}($1::jsonb) AS result`,
          [JSON.stringify(args.p_statements)],
        );
        return { data: result.rows[0]!.result, error: null };
      } catch (error) {
        const { code, message } = error as { code?: string; message: string };
        return { data: null, error: { code, message } };
      }
    },
  }),
}));

/** A Supabase-like database: its three roles, the migrations in order, and the service role's grants. */
const createDatabase = async (before = "") => {
  const db = new PGlite();
  await db.exec(
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
  );
  if (before) await db.exec(before);
  for (const name of [...Object.keys(SHIPPED), LATEST]) {
    await db.exec(await readMigration(name));
  }
  await db.exec(
    "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; SET ROLE service_role;",
  );
  return db;
};

const apply = (db: PGlite, sql: string) =>
  db.query(`SELECT public.${SUPABASE_APPLY_FUNCTION}($1::jsonb)`, [
    JSON.stringify([{ sql, params: [] }]),
  ]);

describe("Supabase schema", () => {
  it("checks in the shipped migrations unchanged and the next one generated", async () => {
    const shipped = await Promise.all(
      Object.keys(SHIPPED).map((name) => readMigration(name)),
    );
    if (process.env.HOT_UPDATER_UPDATE_SQL === "1") {
      await fs.writeFile(
        path.join(MIGRATIONS, LATEST),
        supabaseMigrationSql(managed, shipped),
      );
    }
    const files = (await fs.readdir(MIGRATIONS)).filter((file) =>
      file.endsWith(".sql"),
    );
    expect(files.sort()).toEqual([...Object.keys(SHIPPED), LATEST]);
    expect(
      shipped.map((sql) => createHash("sha256").update(sql).digest("hex")),
    ).toEqual(Object.values(SHIPPED));
    // Regenerate with HOT_UPDATER_UPDATE_SQL=1 after the schema changes.
    expect(await readMigration(LATEST)).toBe(
      supabaseMigrationSql(managed, shipped),
    );
  });

  it("creates the managed schema from the migrations in order, as from the whole schema", async () => {
    const describeSchema = async (db: PGlite) => ({
      tables: (
        await db.query(
          "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        )
      ).rows,
      indexes: (
        await db.query(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
        )
      ).rows,
      apply: (
        await db.query(
          `SELECT prosrc FROM pg_proc WHERE proname = '${SUPABASE_APPLY_FUNCTION}'`,
        )
      ).rows,
      settings: (
        await db.query(
          `SELECT key, value FROM public."${SUPABASE_SETTINGS_TABLE}" ORDER BY key`,
        )
      ).rows,
    });
    const migrated = await createDatabase();
    const created = new PGlite();
    await created.exec(
      "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
    );
    await created.exec(supabaseSchemaSql(managed));
    expect(await describeSchema(migrated)).toEqual(
      await describeSchema(created),
    );
    await migrated.close();
    await created.close();
  });

  it("writes into a later migration only what the earlier ones did not create, the apply RPC with its grants, and every settings row", async () => {
    const audit = definePlugin({
      id: "audit",
      schemaVersion: "1",
      schema: {
        entries: defineTable({ id: { type: "string" } }, { key: ["id"] }),
      },
      init: () => ({ api: {} }),
    });
    const later = toolingTargetOf([
      insights(),
      apiKeys(),
      remoteConfig(),
      audit,
    ]);
    const statements = supabaseMigrationStatements(
      supabaseMigrationSql(later, [supabaseSchemaSql(managed)]),
    );
    expect(
      statements.map((sql) => sql.split("\n")[0]!.replace(/ VALUES .*/u, "")),
    ).toEqual([
      'CREATE TABLE IF NOT EXISTS "hot_updater_v1_audit_entries" ("id" text COLLATE "C" NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"))',
      'ALTER TABLE "hot_updater_v1_audit_entries" ENABLE ROW LEVEL SECURITY',
      `CREATE OR REPLACE FUNCTION public.${SUPABASE_APPLY_FUNCTION}(p_statements jsonb)`,
      `REVOKE EXECUTE ON FUNCTION public.${SUPABASE_APPLY_FUNCTION}(jsonb) FROM PUBLIC, anon, authenticated`,
      `GRANT EXECUTE ON FUNCTION public.${SUPABASE_APPLY_FUNCTION}(jsonb) TO service_role`,
      ...Object.keys(later.settings).map(
        () => `INSERT INTO "${SUPABASE_SETTINGS_TABLE}" ("key", "value", "_v")`,
      ),
    ]);
  });

  it("creates namespaced tables with row-level security beside a v0 schema it leaves alone", async () => {
    const db = await createDatabase(`
      CREATE TABLE public.channels (id text PRIMARY KEY, name text NOT NULL);
      INSERT INTO public.channels VALUES ('legacy-channel', 'legacy');
    `);
    const tables = await db.query<{ name: string; secured: boolean }>(
      "SELECT tablename AS name, rowsecurity AS secured FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const ours = tables.rows.filter(({ name }) =>
      name.startsWith("hot_updater_v1_"),
    );
    expect(ours.map(({ name }) => name)).toEqual(
      supabaseTableNames(managed.schema).toSorted(),
    );
    expect(ours.every(({ secured }) => secured)).toBe(true);
    await expect(
      db.query("SELECT name FROM public.channels"),
    ).resolves.toMatchObject({ rows: [{ name: "legacy" }] });
    const settings = await db.query<{ key: string }>(
      `SELECT key FROM public."${SUPABASE_SETTINGS_TABLE}" ORDER BY key`,
    );
    expect(settings.rows.map(({ key }) => key)).toEqual([
      "schema.apiKeys",
      "schema.core",
      "schema.engine",
      "schema.insights",
      "schema.remoteConfig",
    ]);
    await db.close();
  });

  it("lets only the service role run the apply RPC", async () => {
    const db = await createDatabase();
    const privilege = await db.query<Record<string, boolean>>(
      ["anon", "authenticated", "service_role"]
        .map(
          (role) =>
            `has_function_privilege('${role}', 'public.${SUPABASE_APPLY_FUNCTION}(jsonb)', 'EXECUTE') AS ${role}`,
        )
        .join(", ")
        .replace(/^/u, "SELECT "),
    );
    expect(privilege.rows).toEqual([
      { anon: false, authenticated: false, service_role: true },
    ]);
    await db.close();
  });

  it("refuses anything but the SQL core's statements on Hot Updater tables", async () => {
    const db = await createDatabase();
    const bundles = '"hot_updater_v1_bundles"';
    for (const sql of [
      "SELECT * FROM pg_authid",
      'SELECT * FROM "pg_authid"',
      `SELECT pg_sleep(0) FROM ${bundles}`,
      `SELECT "pg_sleep"(0) FROM ${bundles}`,
      `SELECT 'text' FROM ${bundles}`,
      `SELECT * FROM ${bundles} -- comment`,
      `SELECT * FROM ${bundles}; DELETE FROM ${bundles}`,
      `DROP TABLE ${bundles}`,
      `SELECT * FROM ${bundles} UNION SELECT * FROM ${bundles}`,
    ]) {
      await expect(apply(db, sql), sql).rejects.toMatchObject({
        code: "42501",
      });
    }
    const allowed = toApplyStatement({
      sql: `SELECT * FROM ${bundles} WHERE ("id" = $1) OR ("id" = $2) ORDER BY "id" DESC LIMIT 5`,
      params: ["a", "b"],
    });
    await expect(
      db.query(`SELECT public.${SUPABASE_APPLY_FUNCTION}($1::jsonb) AS r`, [
        JSON.stringify([allowed]),
      ]),
    ).resolves.toMatchObject({ rows: [{ r: [{ rows: [], changes: 0 }] }] });
    await db.close();
  });

  it("generates a migration that adds a server's plugin tables to the apply RPC", async () => {
    const notes = definePlugin({
      id: "notes",
      schemaVersion: "1",
      schema: {
        notes: defineTable(
          { id: { type: "string" }, text: { type: "string" } },
          { key: ["id"] },
        ),
      },
      init: ({ db }) => ({
        api: {
          add: (id: string, text: string) =>
            db.transaction(async (tx) => {
              tx.create("notes", { id, text });
            }),
          read: (id: string) => db.findOne("notes", { id }),
        },
      }),
    });
    const hotUpdater = createHotUpdater({
      database: supabaseToolingDatabase({
        supabaseUrl: "https://project.supabase.co",
        supabaseServiceRoleKey: "service-role-key",
      }),
      storage: createReleaseCatalogTestStorage(),
      plugins: [notes],
      clientAccess: "public",
    });
    // The apply RPC runs no DDL, so the schema comes from migration files.
    expect(() => createMigrator(hotUpdater)).toThrow(
      "run `hot-updater db generate`",
    );
    const migration = generateSchema(hotUpdater, "latest");
    expect(migration.path).toMatch(
      /^supabase\/migrations\/\d{14}_hot-updater\.sql$/u,
    );

    const db = await createDatabase();
    state.db = db;
    try {
      // Its tables come from migration files, which the fix names.
      await expect(hotUpdater.api.notes.read("n1")).rejects.toThrow(
        'The tables of plugin "notes" are not migrated on supabaseDatabase: schema setting "schema.notes" is missing; expected "1". Run `npx hot-updater doctor --fix` in the project whose hot-updater.config.ts names this database. On a database `hot-updater init` created, it applies the provider\'s migrations; for your own server, run `hot-updater db generate` and apply the file it writes.',
      );
      await db.exec(
        `RESET ROLE; ${migration.code} GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; SET ROLE service_role;`,
      );
      await hotUpdater.api.notes.add("n1", "hello");
      await expect(hotUpdater.api.notes.read("n1")).resolves.toEqual({
        id: "n1",
        text: "hello",
      });
      const secured = await db.query<{ secured: boolean }>(
        "SELECT rowsecurity AS secured FROM pg_tables WHERE tablename = 'hot_updater_v1_notes_notes'",
      );
      expect(secured.rows).toEqual([{ secured: true }]);
    } finally {
      state.db = undefined;
      await db.close();
    }
  });
});

describe("toApplyStatement", () => {
  it("reads each value from the jsonb array, typed, and writes a null inline", () => {
    expect(
      toApplyStatement({
        sql: 'UPDATE "t" SET "a" = $1, "b" = $2, "c" = $3, "d" = $4::jsonb, "e" = $5 WHERE "id" = $6',
        params: [1, 1.5, true, '{"x":1}', null, "id"],
      }),
    ).toEqual({
      sql: 'UPDATE "t" SET "a" = ($1->>0)::bigint, "b" = ($1->>1)::double precision, "c" = ($1->>2)::boolean, "d" = ($1->>3)::jsonb, "e" = NULL WHERE "id" = ($1->>4)',
      params: [1, 1.5, true, '{"x":1}', "id"],
    });
  });
});

describe("supabaseDatabase over the apply RPC", () => {
  beforeAll(async () => {
    state.db = await createDatabase();
  });
  afterAll(async () => {
    await state.db?.close();
  });

  setupDatabaseTestSuite({
    createHttpClient: (options) =>
      startHttpTestServer(
        createHotUpdater({
          ...options,
          plugins: [insights()],
          clientAccess: "public",
        }).handlers,
      ),
    plugins: [
      insightsTestSuite({
        createModel: (database) =>
          createInsightsModel(
            createHotUpdater({
              database,
              storage: createReleaseCatalogTestStorage(),
              plugins: [insights()],
              clientAccess: "public",
            }).api.insights,
          ),
      }),
    ],
    name: "supabaseDatabase (PGlite, apply RPC)",
    migrate: () => undefined,
    createDatabase: () =>
      supabaseDatabase({
        supabaseUrl: "https://project.supabase.co",
        supabaseServiceRoleKey: "service-role-key",
      }),
    reset: async () => {
      const tables = supabaseTableNames(managed.schema)
        .filter((table) => table !== SUPABASE_SETTINGS_TABLE)
        .map((table) => `public."${table}"`);
      await state.db!.exec(`TRUNCATE ${tables.join(", ")} CASCADE`);
    },
    dispose: () => undefined,
  });
});
