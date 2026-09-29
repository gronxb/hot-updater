import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseHarness } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createHotUpdater } from "../createHotUpdaterCore";
import { defineTable } from "../database/schema";
import { listHotUpdaterRoutes } from "../handler";
import { definePlugin } from "../plugins/definePlugin";
import { HotUpdaterConfigError } from "./assemblePlugins";

const database = () => ({
  ...createInMemoryDatabaseHarness().plugin,
  engineAdapter: createMemoryAdapter(),
});

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      { id: { type: "string" }, text: { type: "string" } },
      { key: ["id"] },
    ),
  },
  init: ({ db, now }) => ({
    api: {
      add: (id: string, text: string) =>
        db.transaction(async (tx) => {
          tx.create("notes", { id, text });
        }),
      read: (id: string) => db.findOne("notes", { id }),
      now,
    },
    endpoints: [
      {
        method: "GET",
        path: "/notes/:id",
        access: "client",
        handler: async (_request, params) =>
          Response.json(await db.findOne("notes", { id: params.id! }), {
            headers: { "cache-control": "public, max-age=60" },
          }),
      },
      {
        method: "DELETE",
        path: "/notes/:id",
        access: "admin",
        handler: async () => new Response(null, { status: 204 }),
      },
    ],
  }),
});

const keys = (
  authenticate = async (headers: Headers) => headers.get("x-key") === "valid",
) =>
  definePlugin({
    id: "keys",
    provides: { clientAuth: true },
    schemaVersion: "1",
    schema: {},
    init: () => ({
      api: {},
      clientAuth: { varyHeaders: ["X-Key"], authenticate },
    }),
  });

const startup = (options: Record<string, unknown>) => () =>
  createHotUpdater({ database: database(), ...options } as never);

describe("createHotUpdater with plugins", () => {
  it("gives each plugin its own tables on the engine and exposes its API by id", async () => {
    const hotUpdater = createHotUpdater({
      database: database(),
      plugins: [notes],
      clientAccess: "public",
    });
    await hotUpdater.api.notes.add("n1", "hello");
    await expect(hotUpdater.api.notes.read("n1")).resolves.toEqual({
      id: "n1",
      text: "hello",
    });
    expect(hotUpdater.api.notes.now()).toBeTypeOf("number");
  });

  it("mounts endpoints by access and lists every route with its access", () => {
    const { handlers } = createHotUpdater({
      database: database(),
      plugins: [notes, keys()],
    });
    expect(listHotUpdaterRoutes(handlers)).toEqual([
      { method: "GET", path: "/version", access: "public" },
      {
        method: "GET",
        path: "/release-catalogs/app-version/:platform/:channelKey/:appVersion",
        access: "client",
      },
      {
        method: "GET",
        path: "/release-catalogs/fingerprint/:platform/:channelKey/:fingerprintHash",
        access: "client",
      },
      {
        method: "GET",
        path: "/artifacts/v1/:targetBundleId/from/:currentBundleId",
        access: "client",
      },
      { method: "POST", path: "/events", access: "client" },
      { method: "GET", path: "/version", access: "admin" },
      { method: "POST", path: "/releases", access: "admin" },
      { method: "POST", path: "/releases/:id/promote", access: "admin" },
      { method: "GET", path: "/releases/:id", access: "admin" },
      { method: "GET", path: "/releases", access: "admin" },
      { method: "PATCH", path: "/releases/:id", access: "admin" },
      { method: "POST", path: "/releases/:id/preflight", access: "admin" },
      { method: "DELETE", path: "/releases/:id", access: "admin" },
      { method: "GET", path: "/release-catalogs/:scopeKey", access: "admin" },
      { method: "GET", path: "/release-catalogs", access: "admin" },
      {
        method: "POST",
        path: "/release-catalogs/:scopeKey/rebuild",
        access: "admin",
      },
      {
        method: "POST",
        path: "/release-catalogs/:scopeKey/preflight",
        access: "admin",
      },
      { method: "POST", path: "/database/commit", access: "admin" },
      { method: "GET", path: "/channels", access: "admin" },
      { method: "POST", path: "/channels", access: "admin" },
      { method: "DELETE", path: "/channels/:id", access: "admin" },
      { method: "GET", path: "/bundles/:id", access: "admin" },
      { method: "GET", path: "/bundles", access: "admin" },
      { method: "POST", path: "/bundles", access: "admin" },
      { method: "PATCH", path: "/bundles/:id", access: "admin" },
      { method: "DELETE", path: "/bundles/:id", access: "admin" },
      { method: "POST", path: "/bundles/delete", access: "admin" },
      { method: "GET", path: "/bundles/:id/children", access: "admin" },
      {
        method: "GET",
        path: "/base-candidates/:candidateKey",
        access: "admin",
      },
      { method: "GET", path: "/events", access: "admin" },
      { method: "GET", path: "/overview", access: "admin" },
      { method: "GET", path: "/installations", access: "admin" },
      {
        method: "GET",
        path: "/installations/:installId/events",
        access: "admin",
      },
      { method: "GET", path: "/installations/:installId", access: "admin" },
      { method: "GET", path: "/notes/:id", access: "client" },
      { method: "DELETE", path: "/notes/:id", access: "admin" },
    ]);
  });

  it("puts client routes and client endpoints behind clientAuth, never /version, and varies cacheable answers", async () => {
    const authenticate = vi.fn(async (headers: Headers) => {
      if (headers.get("x-key") === "down") throw new Error("unavailable");
      return headers.get("x-key") === "valid";
    });
    const hotUpdater = createHotUpdater({
      database: database(),
      plugins: [notes, keys(authenticate)],
    });
    await hotUpdater.api.notes.add("n1", "hello");
    const client = (path: string, key?: string) =>
      hotUpdater.handlers.client(
        new Request(`https://updates.example.com${path}`, {
          headers: key === undefined ? {} : { "x-key": key },
        }),
      );

    expect((await client("/version")).status).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
    expect((await client("/notes/n1")).status).toBe(401);
    expect((await client("/notes/n1", "down")).status).toBe(503);
    const allowed = await client("/notes/n1", "valid");
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ text: "hello" });
    expect(allowed.headers.get("vary")).toBe("x-key");
    expect(
      (
        await hotUpdater.handlers.admin(
          new Request("https://updates.example.com/notes/n1", {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(204);
  });

  it("leaves client routes open with clientAccess: public", async () => {
    const hotUpdater = createHotUpdater({
      database: database(),
      plugins: [notes],
      clientAccess: "public",
    });
    await hotUpdater.api.notes.add("n1", "hello");
    const response = await hotUpdater.handlers.client(
      new Request("https://updates.example.com/notes/n1"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBeNull();
  });

  it("rejects every misconfiguration at startup", () => {
    const valid = {
      id: "valid",
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: {} }),
    };
    const cases: [Record<string, unknown>, string][] = [
      [{ plugins: [notes] }, 'Set clientAccess to "public"'],
      [
        { plugins: [keys()], clientAccess: "public" },
        'Plugin "keys" provides clientAuth, so remove clientAccess.',
      ],
      [
        {
          plugins: [keys(), { ...keys(), id: "sso" }],
        },
        'Plugins "keys" and "sso" both provide clientAuth; keep one.',
      ],
      [
        { plugins: [valid, valid], clientAccess: "public" },
        'Plugin "valid" is registered twice.',
      ],
      [
        { plugins: [{ ...valid, kind: "core" }], clientAccess: "public" },
        "plugins[0] has a kind; core is built in and is never passed as a plugin.",
      ],
      [
        { plugins: [{ ...valid, hooks: {} }], clientAccess: "public" },
        'plugins[0] has an unknown key "hooks".',
      ],
      [
        {
          plugins: [{ ...valid, init: async () => ({ api: {} }) }],
          clientAccess: "public",
        },
        'Plugin "valid" init returned a promise; init must be synchronous.',
      ],
      [
        {
          plugins: [{ ...valid, provides: { clientAuth: true } }],
          clientAccess: "public",
        },
        'Plugin "valid" declares provides: { clientAuth: true } but its instance has no clientAuth.',
      ],
      [
        {
          plugins: [
            {
              ...valid,
              init: () => ({
                api: {},
                clientAuth: { varyHeaders: [], authenticate: async () => true },
              }),
            },
          ],
          clientAccess: "public",
        },
        'Plugin "valid" returns clientAuth without declaring provides: { clientAuth: true }.',
      ],
      [
        {
          plugins: [
            {
              ...valid,
              init: () => ({
                api: {},
                endpoints: [
                  {
                    method: "GET",
                    path: "/version",
                    access: "client",
                    handler: async () => new Response(),
                  },
                ],
              }),
            },
          ],
          clientAccess: "public",
        },
        "plugin valid: GET /version (GET /version) collides with version on handlers.client.",
      ],
      [
        { plugins: [{ ...valid, id: "Valid" }], clientAccess: "public" },
        "plugins[0] needs an id matching ^[a-z][a-z0-9_]*$.",
      ],
    ];
    for (const [options, message] of cases) {
      const run = startup(options);
      expect(run).toThrow(HotUpdaterConfigError);
      expect(run).toThrow(message);
    }
    const { engineAdapter: _, ...legacy } = database();
    expect(() =>
      createHotUpdater({
        database: legacy,
        plugins: [notes],
        clientAccess: "public",
      }),
    ).toThrow(
      'Plugin "notes" has tables, and this database does not run on the storage engine yet.',
    );
  });
});
