import type { DatabasePlugin } from "@hot-updater/plugin-core";
import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";
import {
  createPluginTestHarness,
  setupInsightsModelTestSuite,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createInMemoryDatabaseHarness } from "../../../../test-utils/test/inMemoryDatabasePlugin";
import { createHotUpdater } from "../../createHotUpdaterCore";
import * as engine from "../../database";
import { definePlugin } from "../definePlugin";
import { apiKeys, createApiKeyModel } from "./index";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

/** Today's in-memory database, with its API key model on the plugin's tables. */
const legacy = createInMemoryDatabaseHarness();
let model: DatabasePlugin["models"]["apiKeys"] | undefined;
const current = () => model!;
setupInsightsModelTestSuite({
  name: "in-memory database with the API keys plugin model",
  createPlugin: () => ({
    ...legacy.plugin,
    models: {
      ...legacy.plugin.models,
      apiKeys: {
        create: (row) => current().create(row),
        findByHash: (hash) => current().findByHash(hash),
        list: () => current().list(),
        revoke: (input) => current().revoke(input),
      },
    },
  }),
  migrate: () => undefined,
  reset: async () => {
    legacy.reset();
    const harness = await createPluginTestHarness(apiKeys(), { engine });
    model = createApiKeyModel(harness.db as never);
  },
  dispose: () => undefined,
});

/** A client endpoint with a cacheable answer, to see the policy's Vary. */
const cached = definePlugin({
  id: "cached",
  schemaVersion: "1",
  schema: {},
  init: () => ({
    api: {},
    endpoints: [
      {
        method: "GET",
        path: "/cached",
        access: "client",
        handler: async () =>
          new Response("ok", {
            headers: { "cache-control": "public, max-age=60" },
          }),
      },
    ],
  }),
});

const start = (
  options: { headerName?: string; adapter?: DatabaseAdapter } = {},
) => {
  const hotUpdater = createHotUpdater({
    database: {
      ...createInMemoryDatabaseHarness().plugin,
      engineAdapter: options.adapter ?? createMemoryAdapter(),
    },
    plugins: [
      apiKeys(
        options.headerName === undefined
          ? {}
          : { headerName: options.headerName },
      ),
      cached,
    ],
  });
  const client = (
    path: string,
    headers: Record<string, string> = {},
    init: RequestInit = {},
  ) =>
    hotUpdater.handlers.client(
      new Request(`https://updates.example.com${path}`, { ...init, headers }),
    );
  return { hotUpdater, client };
};

describe("API keys plugin", () => {
  it("protects every client route but /version with a registered, active key", async () => {
    const { hotUpdater, client } = start();
    await hotUpdater.api.apiKeys.register({ apiKey: API_KEY, name: "App" });
    const catalog = "/release-catalogs/app-version/ios/production/1.0.0";

    expect((await client("/version")).status).toBe(200);
    expect((await client(catalog)).status).toBe(401);
    expect((await client(catalog, { "x-api-key": "not-a-key" })).status).toBe(
      401,
    );
    expect(
      (await client("/events", {}, { method: "POST", body: "{" })).status,
    ).toBe(401);
    expect(
      (
        await client(
          "/events",
          { "x-api-key": API_KEY },
          { method: "POST", body: "{" },
        )
      ).status,
    ).toBe(400);
    const allowed = await client("/cached", { "x-api-key": API_KEY });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("vary")).toBe("x-api-key");
  });

  it("creates keys once in plaintext, lists and revokes them without hashes", async () => {
    const { hotUpdater, client } = start();
    const created = await hotUpdater.api.apiKeys.create({ name: " Deploy " });
    expect(created.record).toMatchObject({
      name: "Deploy",
      prefix: created.apiKey.slice(0, 6),
      role: "client",
      revoked_at_ms: null,
    });
    const listed = await hotUpdater.api.apiKeys.list();
    expect(listed).toEqual([created.record]);
    expect(JSON.stringify(listed)).not.toContain("hash");
    expect(
      (await client("/cached", { "x-api-key": created.apiKey })).status,
    ).toBe(200);

    await expect(
      hotUpdater.api.apiKeys.revoke({ id: created.record.id }),
    ).resolves.toMatchObject({
      id: created.record.id,
      revoked_at_ms: expect.any(Number),
    });
    expect(
      (await client("/cached", { "x-api-key": created.apiKey })).status,
    ).toBe(401);
    await expect(
      hotUpdater.api.apiKeys.revoke({ id: "missing" }),
    ).resolves.toBeNull();
  });

  it("provisions a saved key idempotently and a new key otherwise", async () => {
    const { hotUpdater } = start();
    const first = await hotUpdater.api.apiKeys.provision({
      existingApiKey: API_KEY,
      name: "Managed",
    });
    const again = await hotUpdater.api.apiKeys.provision({
      existingApiKey: ` ${API_KEY} `,
      name: "Managed",
    });
    expect(again.record.id).toBe(first.record.id);
    const fresh = await hotUpdater.api.apiKeys.provision({ name: "Managed" });
    expect(fresh.apiKey).not.toBe(API_KEY);
    expect(await hotUpdater.api.apiKeys.list()).toHaveLength(2);
  });

  it("reads keys only from the configured header and varies by it", async () => {
    const { hotUpdater, client } = start({ headerName: "X-Hot-Updater-Key" });
    await hotUpdater.api.apiKeys.register({ apiKey: API_KEY, name: "App" });

    expect((await client("/cached", { "x-api-key": API_KEY })).status).toBe(
      401,
    );
    const allowed = await client("/cached", { "x-hot-updater-key": API_KEY });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("vary")).toBe("x-hot-updater-key");
    expect(() => apiKeys({ headerName: "invalid header" })).toThrow(
      "valid header name",
    );
  });

  it("answers 503 when credential storage is unavailable", async () => {
    const memory = createMemoryAdapter();
    const { client } = start({
      adapter: {
        ...memory,
        get: async () => {
          throw new Error("storage unavailable");
        },
        query: async () => {
          throw new Error("storage unavailable");
        },
      },
    });
    expect((await client("/cached", { "x-api-key": API_KEY })).status).toBe(
      503,
    );
    expect((await client("/version")).status).toBe(200);
  });
});
