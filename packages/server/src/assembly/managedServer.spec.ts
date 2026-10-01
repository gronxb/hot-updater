import {
  createStorageAdapter,
  createMemoryAdapter,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../createHotUpdaterCore";
import { definePlugin } from "../plugins/definePlugin";
import { insights } from "../plugins/insights";
import { managedServerDefinitionOf } from "./managedServer";

const cloudflare = {
  provider: "Cloudflare",
  database: "d1Database",
  storage: "r2",
} as const;

const d1 = () => ({ name: "d1Database", adapter: createMemoryAdapter() });
const r2 = createStorageAdapter({ name: "r2Storage", protocol: "r2" });
const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {},
  init: () => ({
    api: {},
    endpoints: [
      {
        method: "GET",
        path: "/notes/:id",
        access: "client",
        handler: async () => Response.json({}),
      },
      {
        method: "DELETE",
        path: "/notes/:id",
        access: "admin",
        handler: async () => Response.json({}),
      },
    ],
  }),
});

describe("managedServerDefinitionOf", () => {
  it("runs the definition's plugins, the project's own among them, and lists their client endpoints", () => {
    const plugins = [insights(), notes];

    const definition = managedServerDefinitionOf(
      createHotUpdater({
        database: d1(),
        storage: [r2],
        plugins,
        clientAccess: "public",
      }),
      cloudflare,
    );

    expect(definition.plugins).toBe(plugins);
    // A host that routes by path sends these to the server; admin ones stay behind the host.
    expect(definition.clientEndpoints).toEqual([
      { plugin: "insights", method: "POST", path: "/events" },
      { plugin: "notes", method: "GET", path: "/notes/:id" },
    ]);
  });

  it("runs none of Hot Updater's own plugins when the definition leaves them out", () => {
    expect(
      managedServerDefinitionOf(
        createHotUpdater({
          database: d1(),
          storage: [r2],
          clientAccess: "public",
        }),
        cloudflare,
      ),
    ).toMatchObject({ plugins: [], clientEndpoints: [] });
  });

  it("refuses a database or storage the managed server does not run on", () => {
    expect(() =>
      managedServerDefinitionOf(
        createHotUpdater({
          database: { name: "postgres", adapter: createMemoryAdapter() },
          storage: [r2],
          clientAccess: "public",
        }),
        cloudflare,
      ),
    ).toThrow(
      "The managed Cloudflare server runs on d1Database, but the server definition's database is postgres.",
    );
    expect(() =>
      managedServerDefinitionOf(
        createHotUpdater({
          database: d1(),
          storage: [
            r2,
            createStorageAdapter({ name: "s3Storage", protocol: "s3" }),
          ],
          clientAccess: "public",
        }),
        cloudflare,
      ),
    ).toThrow(
      "stores bundles in its r2 storage, but the server definition's storage is r2Storage, s3Storage.",
    );
    expect(() =>
      managedServerDefinitionOf({ adapterName: "d1Database" }, cloudflare),
    ).toThrow("The server definition must export hotUpdater");
  });
});
