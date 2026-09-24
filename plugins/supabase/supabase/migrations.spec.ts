import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { createHotUpdater } from "@hot-updater/server";
import { createDatabasePluginApis } from "@hot-updater/server/db";
import {
  createInsightsModel,
  insights,
} from "@hot-updater/server/plugins/insights";
import {
  setupDatabaseTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { supabaseDatabase } from "../src/supabaseDatabase";
import { toApplyStatement } from "../src/supabaseExecutor";
import {
  SUPABASE_APPLY_FUNCTION,
  SUPABASE_SETTINGS_TABLE,
  supabaseSchemaSql,
  supabaseTableNames,
} from "../src/supabaseSchema";

const MIGRATIONS = path.resolve("plugins/supabase/supabase/migrations");
const MIGRATION = path.join(MIGRATIONS, "20260818000000_hot-updater_1.0.0.sql");

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

/** A Supabase-like database: its three roles, the migration, and the service role's grants. */
const createDatabase = async (before = "") => {
  const db = new PGlite();
  await db.exec(
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
  );
  if (before) await db.exec(before);
  await db.exec(await fs.readFile(MIGRATION, "utf8"));
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
  it("checks in exactly the generated migration as the only one", async () => {
    if (process.env.HOT_UPDATER_UPDATE_SQL === "1") {
      await fs.writeFile(MIGRATION, supabaseSchemaSql());
    }
    const files = (await fs.readdir(MIGRATIONS)).filter((file) =>
      file.endsWith(".sql"),
    );
    expect(files).toEqual([path.basename(MIGRATION)]);
    // Regenerate with HOT_UPDATER_UPDATE_SQL=1 after the schema changes.
    expect(await fs.readFile(MIGRATION, "utf8")).toBe(supabaseSchemaSql());
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
      supabaseTableNames().toSorted(),
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
    createInsightsModel: (database) =>
      createInsightsModel(
        createDatabasePluginApis(database, [insights()]).insights,
      ),
    name: "supabaseDatabase (PGlite, apply RPC)",
    migrate: () => undefined,
    createDatabase: () =>
      supabaseDatabase({
        supabaseUrl: "https://project.supabase.co",
        supabaseServiceRoleKey: "service-role-key",
      }),
    reset: async () => {
      const tables = supabaseTableNames()
        .filter((table) => table !== SUPABASE_SETTINGS_TABLE)
        .map((table) => `public."${table}"`);
      await state.db!.exec(`TRUNCATE ${tables.join(", ")} CASCADE`);
    },
    dispose: () => undefined,
  });
});
