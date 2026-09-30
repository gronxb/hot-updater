import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "../createHotUpdaterCore";
import { type HotUpdaterHandlers, listHotUpdaterRoutes } from "../handler";
import { apiKeys } from "../plugins/api-keys";
import { definePlugin } from "../plugins/definePlugin";
import { insights } from "../plugins/insights";
import {
  INSIGHTS_OFF_WARNING,
  INSIGHTS_ROUTES,
} from "../plugins/insights/routes";
import { HotUpdaterConfigError } from "./assemblePlugins";

const database = () => ({ name: "memory", adapter: createMemoryAdapter() });

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("come from the insights plugin when plugins hold it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    expect(warn).not.toHaveBeenCalled();
  });

  it("answer 204 with x-hot-updater-insights: disabled when plugins leave it out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(INSIGHTS_OFF_WARNING);
  });

  it("warn once per server, on the first event dropped without insights()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hotUpdater = createHotUpdater({
      database: database(),
      clientAccess: "public",
    });
    const report = () =>
      hotUpdater.handlers.client(
        request("/events", { method: "POST", body: JSON.stringify(event) }),
      );

    expect(warn).not.toHaveBeenCalled();
    expect((await report()).status).toBe(204);
    expect((await report()).status).toBe(204);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Add insights() from @hot-updater/server/plugins/insights to plugins",
      ),
    );
  });
});

describe("admin /version", () => {
  const plugins = async (hotUpdater: { handlers: HotUpdaterHandlers }) =>
    (
      (await (await hotUpdater.handlers.admin(request("/version"))).json()) as {
        plugins: unknown;
      }
    ).plugins;

  it("lists the built-in plugins the server runs, sorted by id", async () => {
    await expect(
      plugins(
        createHotUpdater({
          database: database(),
          plugins: [insights(), apiKeys()],
        }),
      ),
    ).resolves.toEqual(["apiKeys", "insights"]);
    await expect(
      plugins(
        createHotUpdater({
          database: database(),
          plugins: [insights()],
          clientAccess: "public",
        }),
      ),
    ).resolves.toEqual(["insights"]);
  });

  it("lists none for a server without plugins, whose Insights routes still say it is off", async () => {
    const hotUpdater = createHotUpdater({
      database: database(),
      clientAccess: "public",
    });

    await expect(plugins(hotUpdater)).resolves.toEqual([]);
    const events = await hotUpdater.handlers.admin(request("/events"));
    expect(events.status).toBe(204);
    expect(events.headers.get("x-hot-updater-insights")).toBe("disabled");
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
    const channel = await hotUpdater.core.ensureChannel("production");

    await expect(
      hotUpdater.core.findChannelByName("production"),
    ).resolves.toEqual(channel);
    await expect(hotUpdater.api.channel_names.names()).resolves.toEqual([
      "production",
    ]);
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
