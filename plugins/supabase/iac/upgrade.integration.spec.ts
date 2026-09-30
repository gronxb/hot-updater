import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { createHotUpdater } from "@hot-updater/server";
import { definePlugin, defineTable } from "@hot-updater/server/plugins";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { plugins } from "../src/plugins";
import { supabaseDatabase } from "../src/supabaseDatabase";
import { writePluginMigration } from "./managedEdgeFunction";

const state = vi.hoisted(() => ({ db: undefined as PGlite | undefined }));

/**
 * Supabase's client, as PostgREST runs an RPC: one statement, as the service
 * role.
 */
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

/** A plugin of the project's own, with a table, which the app reads and writes. */
const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      { id: { type: "string", maxLength: 64 }, text: { type: "string" } },
      { key: ["id"] },
    ),
  },
  init: ({ db }) => ({
    api: {},
    endpoints: [
      {
        method: "POST",
        path: "/notes/:id",
        access: "client",
        handler: async (request, params) => {
          const { text } = (await request.json()) as { text: string };
          await db.transaction(async (tx) => {
            tx.create("notes", { id: params.id!, text });
          });
          return new Response(null, { status: 201 });
        },
      },
      {
        method: "GET",
        path: "/notes/:id",
        access: "client",
        handler: async (_request, params) => {
          const note = await db.findOne("notes", { id: params.id! });
          return note === null
            ? Response.json({ error: "Not found" }, { status: 404 })
            : Response.json({ text: note.text });
        },
      },
    ],
  }),
});

const BUNDLE_ID = "00000000-0000-0000-0000-000000000001";
const CATALOG = "/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.0.0";

/** An installation's report of the bundle it runs, which Insights records. */
const installationEvent = {
  type: "UNCHANGED",
  installId: "supabase-installation",
  toBundleId: BUNDLE_ID,
  platform: "ios",
  appVersion: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprintHash: null,
  fromBundleId: null,
  fromReleaseId: null,
  toReleaseId: null,
  updateStrategy: null,
};

/** The managed Edge Function's server with `serverPlugins`, on the database. */
const server = (serverPlugins: readonly unknown[]) =>
  createHotUpdater({
    database: supabaseDatabase({
      supabaseUrl: "https://project.supabase.co",
      supabaseServiceRoleKey: "service-role-key",
    }),
    plugins: serverPlugins as typeof plugins,
  });

const request = (
  hotUpdater: ReturnType<typeof server>,
  pathname: string,
  init?: RequestInit,
) =>
  hotUpdater.handlers.client(
    new Request(`https://project.supabase.co${pathname}`, init),
  );

let db: PGlite;
let workdir: string;
let apiKey = "";
let seededEvents = 0;

/** Applies a migration as `supabase db push` does: as the database's owner. */
const push = (sql: string) =>
  db.exec(`RESET ROLE;\n${sql}\nSET ROLE service_role;`);

/**
 * The migration init writes for `serverPlugins` beside the package's, which
 * `supabase db push` applies alone to a database that already has the
 * package's.
 */
const pushPluginMigration = async (serverPlugins: readonly unknown[]) => {
  const deploy = await fs.mkdtemp(path.join(workdir, "deploy-"));
  const migrations = path.join(deploy, "supabase", "migrations");
  await fs.mkdir(migrations, { recursive: true });
  await writePluginMigration(deploy, serverPlugins);
  const [file] = await fs.readdir(migrations);
  await push(await fs.readFile(path.join(migrations, file!), "utf-8"));
};

const countRows = async (table: string) =>
  (
    await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "hot_updater_v1_${table}"`,
    )
  ).rows[0]!.n;

const settingOf = async (key: string) =>
  (
    await db.query<{ value: string }>(
      `SELECT "value" FROM "hot_updater_v1_private_hot_updater_settings" WHERE "key" = $1`,
      [key],
    )
  ).rows[0]?.value;

describe.sequential("a Supabase project rc.20's init set up, redeployed", () => {
  beforeAll(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-sb-"));
    db = new PGlite();
    state.db = db;
    // Supabase's roles, whose service role gets what the migrations create.
    await db.exec(
      "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;",
    );

    // rc.20's migration, an app's API key, a release, and an installation's
    // Insights, as rc.20's managed server left them.
    await push(
      await fs.readFile(
        path.join(
          import.meta.dirname,
          "__fixtures__",
          "rc.20",
          "20260818000000_hot-updater_1.0.0.sql",
        ),
        "utf-8",
      ),
    );
    const rc20 = server(plugins);
    ({ apiKey } = await rc20.api.apiKeys.create({ name: "rc.20 app" }));
    await rc20.core.deploy([
      {
        bundle: {
          id: BUNDLE_ID,
          platform: "ios",
          gitCommitHash: null,
          manifestStorageUri: `supabase-storage://bundles/${BUNDLE_ID}/manifest.json`,
          manifestFileHash: "manifest-hash",
          assetBaseStorageUri: "supabase-storage://bundles/assets",
        },
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: null,
          message: "rc.20",
          shouldForceUpdate: false,
          targetAppVersion: "1.0",
        },
      },
    ]);
    const reported = await request(rc20, "/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(installationEvent),
    });
    expect(reported.status).toBe(204);
    seededEvents = await countRows("bundle_event_heads");
    expect(seededEvents).toBe(1);
  }, 120_000);

  afterAll(async () => {
    state.db = undefined;
    await db?.close();
    if (workdir !== undefined) {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("gives a definition's own plugin its table beside rc.20's data", async () => {
    const serverPlugins = [...plugins, notes];
    await pushPluginMigration(serverPlugins);
    const hotUpdater = server(serverPlugins);
    const headers = { "x-api-key": apiKey };

    // rc.20's key and release.
    const catalog = await request(hotUpdater, CATALOG, { headers });
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toMatchObject({
      releases: [{ bundleId: BUNDLE_ID }],
    });

    // The plugin, on the table and settings row its migration made.
    expect(await settingOf("schema.notes")).toBe("1");
    const written = await request(hotUpdater, "/notes/welcome", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(written.status).toBe(201);
    const note = await request(hotUpdater, "/notes/welcome", { headers });
    await expect(note.json()).resolves.toEqual({ text: "hello" });

    // Insights, on the tables rc.20's migration made.
    const reported = await request(hotUpdater, "/events", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(installationEvent),
    });
    expect(reported.status).toBe(204);
  });

  it("keeps Insights' tables and rows when the definition drops insights()", async () => {
    const serverPlugins = [
      ...plugins.filter(({ id }) => id !== "insights"),
      notes,
    ];
    await pushPluginMigration(serverPlugins);
    const hotUpdater = server(serverPlugins);
    const headers = { "x-api-key": apiKey };

    expect((await request(hotUpdater, CATALOG, { headers })).status).toBe(200);
    await expect(
      (await request(hotUpdater, "/notes/welcome", { headers })).json(),
    ).resolves.toEqual({ text: "hello" });
    // The server no longer serves Insights' endpoint.
    expect(
      (
        await request(hotUpdater, "/events", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(installationEvent),
        })
      ).status,
    ).toBe(404);

    // Its tables, rows, and settings row stay, for a definition that adds
    // it back.
    expect(await countRows("bundle_event_heads")).toBe(seededEvents);
    expect(await settingOf("schema.insights")).toBeDefined();
    // And a definition that does serves them again.
    const restored = server([...plugins, notes]);
    await pushPluginMigration([...plugins, notes]);
    expect(
      (
        await request(restored, "/events", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(installationEvent),
        })
      ).status,
    ).toBe(204);
  });
});
