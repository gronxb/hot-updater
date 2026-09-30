import { createHotUpdater } from "@hot-updater/server";
import { toolingTargetOf } from "@hot-updater/server/database";
import { definePlugin, defineTable } from "@hot-updater/server/plugins";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { d1SchemaStatements } from "../../src/d1Schema";
import { d1Database as d1BindingDatabase } from "../../src/worker";
import {
  d1Database,
  plugins,
  r2Storage,
  serveManagedWorker,
} from "../../src/worker/managed";

const PUBLIC_BASE_URL = "https://updates.example.com";
const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

/** A third-party plugin a project adds to its server definition. */
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
    },
    endpoints: [
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

const serverPlugins = [...plugins, notes];

/*
 * The project's server definition as the managed Worker runs it: the
 * definition calls the factories of `@hot-updater/cloudflare` with the CLI's
 * credentials, and the Worker's runtime module serves them on its bindings.
 */
const worker = serveManagedWorker(
  createHotUpdater({
    database: d1Database({
      accountId: "the CLI's",
      cloudflareApiToken: "the CLI's",
      databaseId: "the CLI's",
    }),
    storage: [r2Storage({ bucketName: "the CLI's" })],
    plugins: serverPlugins,
  }),
);

const get = (path: string, headers?: HeadersInit) =>
  worker.fetch(new Request(`${PUBLIC_BASE_URL}${path}`, { headers }), env);

describe("the managed Worker with a project's plugin", () => {
  beforeAll(async () => {
    // What init's migration applies before the Worker serves.
    await env.DB.batch(
      d1SchemaStatements(toolingTargetOf(serverPlugins)).map((statement) =>
        env.DB.prepare(statement),
      ),
    );
    const { api } = createHotUpdater({
      database: d1BindingDatabase(env.DB),
      plugins: serverPlugins,
    });
    await api.apiKeys.register({ apiKey: API_KEY, name: "Managed Worker" });
    await api.notes.add("welcome", "hello from D1");
  });

  it("serves the plugin's client endpoint behind the API key", async () => {
    expect((await get("/notes/welcome")).status).toBe(401);

    const response = await get("/notes/welcome", { "x-api-key": API_KEY });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "hello from D1" });

    const missing = await get("/notes/other", { "x-api-key": API_KEY });
    expect(missing.status).toBe(404);
  });

  it("keeps the official plugins' routes", async () => {
    const reported = await worker.fetch(
      new Request(`${PUBLIC_BASE_URL}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          appVersion: "1.0",
          channel: "production",
          cohort: "default",
          fingerprintHash: null,
          fromBundleId: null,
          fromReleaseId: null,
          installId: "install-1",
          platform: "ios",
          toBundleId: "00000000-0000-7000-8000-000000000001",
          toReleaseId: null,
          type: "UNCHANGED",
          updateStrategy: null,
        }),
      }),
      env,
    );
    expect(reported.status).toBe(204);
  });
});
