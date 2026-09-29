import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import { createInMemoryDatabaseHarness } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createHotUpdater } from "../createHotUpdaterCore";
import { createLegacyDatabasePlugin } from "../database/legacyFacade";
import { listHotUpdaterRoutes } from "../handler";
import { INSIGHTS_ROUTES } from "../insights/routes";
import { definePlugin } from "../plugins/definePlugin";
import { insights } from "../plugins/insights";
import { HotUpdaterConfigError } from "./assemblePlugins";

const database = () =>
  createLegacyDatabasePlugin({
    name: "memory",
    adapter: createMemoryAdapter(),
  });

const event = {
  appVersion: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprintHash: null,
  fromBundleId: null,
  fromReleaseId: null,
  installId: "install-1",
  platform: "ios",
  toBundleId: "bundle-1",
  toReleaseId: null,
  type: "UNCHANGED",
  updateStrategy: null,
  userId: "user-1",
  username: "Jane",
  sdkVersion: "2.0.0",
} as const;

const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://updates.example.com${path}`, init);

const insightsRoutes = INSIGHTS_ROUTES.map(({ method, path, access }) => ({
  method,
  path,
  access,
}));

describe("Insights routes with plugins", () => {
  it("come from the insights plugin when plugins hold it", async () => {
    const hotUpdater = createHotUpdater({
      database: database(),
      plugins: [insights()],
      clientAccess: "public",
    });

    const ingested = await hotUpdater.handlers.client(
      request("/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      }),
    );
    expect(ingested.status).toBe(204);
    expect(ingested.headers.get("x-hot-updater-insights")).toBeNull();
    const installation = await hotUpdater.handlers.admin(
      request("/installations/install-1"),
    );
    await expect(installation.json()).resolves.toMatchObject({
      latestStatus: "UNCHANGED",
      lastKnownBundleId: "bundle-1",
    });
    expect(listHotUpdaterRoutes(hotUpdater.handlers)).toEqual(
      expect.arrayContaining(insightsRoutes),
    );
  });

  it("answer 204 with x-hot-updater-insights: disabled when plugins leave it out", async () => {
    const hotUpdater = createHotUpdater({
      database: database(),
      plugins: [],
      clientAccess: "public",
    });

    for (const { access, method, path } of INSIGHTS_ROUTES) {
      const response = await hotUpdater.handlers[access](
        request(path.replace(":installId", "install-1"), {
          method,
          ...(method === "POST" ? { body: JSON.stringify(event) } : {}),
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(204);
      expect(response.headers.get("x-hot-updater-insights")).toBe("disabled");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(listHotUpdaterRoutes(hotUpdater.handlers)).toEqual(
      expect.arrayContaining(insightsRoutes),
    );
  });
});

describe("core reads", () => {
  it("reads core through hotUpdater.core and a plugin's ctx.core", async () => {
    const channels = definePlugin({
      id: "channel_names",
      schemaVersion: "1",
      schema: {},
      init: ({ core }) => ({
        api: {
          names: async () =>
            (await core.listChannels()).map((channel) => channel.name),
        },
      }),
    });
    const hotUpdater = createHotUpdater({
      database: database(),
      plugins: [channels],
      clientAccess: "public",
    });
    await hotUpdater.insertChannel({
      onConflict: "returnExisting",
      row: { id: "channel-1", name: "production" },
    });

    await expect(
      hotUpdater.core.findChannelByName("production"),
    ).resolves.toMatchObject({ id: "channel-1" });
    await expect(hotUpdater.api.channel_names.names()).resolves.toEqual([
      "production",
    ]);
  });

  it("refuses core reads on a database off the storage engine", async () => {
    const hotUpdater = createHotUpdater({
      database: createInMemoryDatabaseHarness().plugin,
      plugins: [],
      clientAccess: "public",
    });

    await expect(hotUpdater.core.listChannels()).rejects.toThrow(
      "This database does not run on the storage engine, so core reads and plugin tables are unavailable.",
    );
  });

  it('keeps the plugin id "core" for core', () => {
    const impostor = definePlugin({
      id: "core",
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: {} }),
    });
    const start = () =>
      createHotUpdater({
        database: database(),
        plugins: [impostor],
        clientAccess: "public",
      });

    expect(start).toThrow(HotUpdaterConfigError);
    expect(start).toThrow(
      'plugins[0] uses the id "core", which is core\'s own.',
    );
  });
});
