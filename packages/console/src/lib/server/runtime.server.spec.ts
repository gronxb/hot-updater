// @vitest-environment node

import type {
  AnyHotUpdaterPlugin,
  EngineDatabase,
  HotUpdaterCoreApi,
  RemoteDatabase,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import {
  insights,
  type BundleEventRow,
} from "@hot-updater/server/plugins/insights";
import { remoteConfig } from "@hot-updater/server/plugins/remote-config";
import { describe, expect, it, vi } from "vitest";

import { ConsoleFeatureUnavailableError } from "../console-features";
import { createConsoleRuntime, requireFeature } from "./runtime.server";

/** The console over `database`, running `plugins` as the server does. */
const databaseRuntime = (
  database: EngineDatabase,
  plugins: readonly AnyHotUpdaterPlugin[] = [],
) =>
  createConsoleRuntime({
    database,
    plugins,
    api: createHotUpdater({
      database,
      plugins,
      ...(plugins.some(({ provides }) => provides?.clientAuth)
        ? {}
        : { clientAccess: "public" }),
    } as Parameters<typeof createHotUpdater>[0]).api,
  });

const engineDatabase = () => ({
  name: "memory",
  adapter: createMemoryAdapter(),
});

const remoteDatabase = (
  fetchAdmin: RemoteDatabase["fetchAdmin"],
): RemoteDatabase => ({
  name: "standalone-repository",
  core: {} as HotUpdaterCoreApi,
  fetchAdmin,
});

const event = (id: string): BundleEventRow =>
  ({
    id,
    type: "UPDATE_APPLIED",
    install_id: "install-1",
    user_id: "user-1",
    from_release_id: "release-0",
    from_bundle_id: "bundle-0",
    to_release_id: "release-1",
    to_bundle_id: "bundle-1",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    metadata: {
      cohort: "1",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: null,
    },
    received_at_ms: Date.now(),
  }) as BundleEventRow;

const refused = (feature: string, message: string) =>
  expect.objectContaining({
    name: "ConsoleFeatureUnavailableError",
    feature,
    status: 404,
    message: expect.stringContaining(message),
  });

describe("createConsoleRuntime over the database", () => {
  it("refuses a plugin that takes a feature's id without being Hot Updater's own", () => {
    const spoof = {
      ...insights(),
      init: () => ({ api: { listEvents: async () => [] } }),
    };

    expect(() => databaseRuntime(engineDatabase(), [spoof as never])).toThrow(
      "which is reserved for Hot Updater's insights() plugin",
    );
  });

  it("serves the features of the plugins it runs, as the server does", async () => {
    const database = engineDatabase();
    const runtime = databaseRuntime(database, [
      insights(),
      apiKeys(),
      remoteConfig(),
    ]);

    expect(runtime.remote).toBe(false);
    await expect(runtime.features()).resolves.toEqual({
      insights: true,
      insightsAnalytics: true,
      apiKeys: true,
      remoteConfig: true,
    });
    const model = await requireFeature(runtime, "insightsAnalytics");
    await model.recordEvent({
      event: event("01900000-0000-7000-8000-000000000001"),
    });
    const reads = await requireFeature(runtime, "insights");
    await expect(
      reads.getInstallation({ installId: "install-1" }),
    ).resolves.toMatchObject({ installId: "install-1" });

    const keys = await requireFeature(runtime, "apiKeys");
    const created = await keys.create({ name: "Console" });
    // The server's own tables: the server's apiKeys() plugin sees the same key.
    await expect(
      createHotUpdater({ database, plugins: [apiKeys()] }).api.apiKeys.list(),
    ).resolves.toEqual([
      expect.objectContaining({ id: created.record.id, name: "Console" }),
    ]);

    const config = await requireFeature(runtime, "remoteConfig");
    await expect(
      config.publish({ template: { parameters: {} }, baseVersion: 0 }),
    ).resolves.toMatchObject({ status: "published" });
    await expect(
      config.publish({
        template: { parameters: { x: { valueType: "COLOR" } } },
        baseVersion: 1,
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      issues: [{ path: "parameters.x.valueType" }],
    });
    // The server's remoteConfig() reads the template the console published.
    await expect(
      createHotUpdater({
        database,
        plugins: [remoteConfig()],
        clientAccess: "public",
      }).api.remoteConfig.getActive(),
    ).resolves.toMatchObject({ version: 1 });
  });

  it("reads a release's update failures through the plugin's API", async () => {
    const runtime = databaseRuntime(engineDatabase(), [insights()]);
    const model = await requireFeature(runtime, "insightsAnalytics");
    const failed = event("01900000-0000-7000-8000-000000000002");
    await model.recordEvent({
      event: {
        ...failed,
        type: "UPDATE_FAILED",
        metadata: {
          ...failed.metadata,
          failure: { stage: "download", reason: "hash_mismatch" },
        },
      } as BundleEventRow,
    });

    const reads = await requireFeature(runtime, "insights");
    await expect(
      reads.getUpdateFailures({
        platform: "ios",
        channel: "production",
        releaseId: "release-1",
      }),
    ).resolves.toMatchObject({ failedUpdates: 1, failedInstallations: 1 });
  });

  it("reports how long the plugin keeps rows", async () => {
    const runtime = databaseRuntime(engineDatabase(), [
      insights({ retention: { rawDays: 30, dailyDays: 60 } }),
    ]);

    const reads = await requireFeature(runtime, "insights");
    await expect(reads.getRetention()).resolves.toEqual({
      rawDays: 30,
      dailyDays: 60,
    });
  });

  it("refuses the features of a plugin that is not listed", async () => {
    const runtime = databaseRuntime(engineDatabase(), [apiKeys()]);

    await expect(runtime.features()).resolves.toEqual({
      insights: false,
      insightsAnalytics: false,
      apiKeys: true,
      remoteConfig: false,
    });
    await expect(requireFeature(runtime, "insights")).rejects.toEqual(
      refused("insights", "without the insights() plugin"),
    );
    await expect(
      requireFeature(runtime, "insightsAnalytics"),
    ).rejects.toBeInstanceOf(ConsoleFeatureUnavailableError);
    await expect(requireFeature(runtime, "apiKeys")).resolves.toBeDefined();
  });

  it("serves no feature without plugins", async () => {
    const runtime = databaseRuntime(engineDatabase());

    await expect(runtime.features()).resolves.toEqual({
      insights: false,
      insightsAnalytics: false,
      apiKeys: false,
      remoteConfig: false,
    });
    await expect(requireFeature(runtime, "apiKeys")).rejects.toEqual(
      refused("apiKeys", "without the apiKeys() plugin"),
    );
  });
});

describe("createConsoleRuntime for a self-hosted server", () => {
  it("takes the features from the config's plugins without asking the server, and serves only what its admin API does", async () => {
    const fetchAdmin = vi.fn(async (_path: string) =>
      Response.json({ data: [], nextCursor: null }),
    );
    const runtime = createConsoleRuntime({
      database: remoteDatabase(fetchAdmin),
      plugins: [insights(), apiKeys(), remoteConfig()],
    });

    expect(runtime.remote).toBe(true);
    await expect(runtime.features()).resolves.toEqual({
      insights: true,
      insightsAnalytics: false,
      apiKeys: false,
      remoteConfig: true,
    });
    expect(fetchAdmin).not.toHaveBeenCalled();
    const reads = await requireFeature(runtime, "insights");
    await reads.listEvents({ limit: 1 });
    // Only the read reaches the server.
    expect(fetchAdmin.mock.calls).toEqual([["/events?limit=1"]]);
    await expect(requireFeature(runtime, "insightsAnalytics")).rejects.toEqual(
      refused("insightsAnalytics", "reaches a self-hosted server"),
    );
    await expect(requireFeature(runtime, "apiKeys")).rejects.toEqual(
      refused("apiKeys", "reaches a self-hosted server"),
    );
  });

  it("serves no feature without its plugin in the config, nor for another plugin that takes its id", async () => {
    const fetchAdmin = vi.fn<RemoteDatabase["fetchAdmin"]>();
    // insights() without its factory's mark, which the server's assembly
    // refuses under that id.
    const spoof = { ...insights() };

    for (const plugins of [[], [spoof]]) {
      const runtime = createConsoleRuntime({
        database: remoteDatabase(fetchAdmin),
        plugins,
      });
      await expect(runtime.features()).resolves.toEqual({
        insights: false,
        insightsAnalytics: false,
        apiKeys: false,
        remoteConfig: false,
      });
      await expect(requireFeature(runtime, "insights")).rejects.toEqual(
        refused("insights", "without the insights() plugin"),
      );
    }
    expect(fetchAdmin).not.toHaveBeenCalled();
  });

  it("reads Insights through the admin routes", async () => {
    const fetchAdmin = vi.fn(async (path: string) =>
      path.startsWith("/installations/")
        ? Response.json({ installId: "install-1" })
        : Response.json({ data: [], nextCursor: null }),
    );
    const reads = await requireFeature(
      createConsoleRuntime({
        database: remoteDatabase(fetchAdmin),
        plugins: [insights()],
      }),
      "insights",
    );

    await reads.listEvents({
      limit: 20,
      beforeReceivedAtMs: 2,
      bundle: {
        platform: "ios",
        channel: "production",
        bundleId: "bundle-1",
        outcome: "applied",
      },
    });
    expect(fetchAdmin).toHaveBeenLastCalledWith(
      "/events?beforeReceivedAtMs=2&limit=20&platform=ios&channel=production&bundleId=bundle-1&outcome=applied",
    );
    await expect(
      reads.getInstallation({ installId: "install 1" }),
    ).resolves.toEqual({ installId: "install-1" });
    expect(fetchAdmin).toHaveBeenLastCalledWith("/installations/install%201");
  });

  it("reads update failures through the admin route, and refuses them from a server that answers 404", async () => {
    const failures = { failedUpdates: 3, failedInstallations: 2 };
    const fetchAdmin = vi.fn(async (path: string) =>
      path.startsWith("/failures?platform=android")
        ? new Response(null, { status: 404 })
        : Response.json(failures),
    );
    const reads = await requireFeature(
      createConsoleRuntime({
        database: remoteDatabase(fetchAdmin),
        plugins: [insights()],
      }),
      "insights",
    );

    await expect(
      reads.getUpdateFailures({
        platform: "ios",
        channel: "production",
        releaseId: "release-1",
        timeRange: { start: 10, end: 20 },
      }),
    ).resolves.toEqual(failures);
    expect(fetchAdmin).toHaveBeenLastCalledWith(
      "/failures?platform=ios&channel=production&releaseId=release-1&start=10&end=20",
    );
    await expect(
      reads.getUpdateFailures({
        platform: "android",
        channel: "production",
        releaseId: "release-1",
      }),
    ).rejects.toEqual(refused("insights", "without the insights() plugin"));
  });

  it("refuses a read the server answers with 404, as after it dropped insights()", async () => {
    const fetchAdmin = vi.fn(async () =>
      Response.json({ error: "Not found" }, { status: 404 }),
    );
    const reads = await requireFeature(
      createConsoleRuntime({
        database: remoteDatabase(fetchAdmin),
        plugins: [insights()],
      }),
      "insights",
    );

    await expect(reads.listEvents({ limit: 1 })).rejects.toEqual(
      refused("insights", "without the insights() plugin"),
    );
    await expect(reads.getRetention()).rejects.toEqual(
      refused("insights", "without the insights() plugin"),
    );
    await expect(
      reads.getInstallation({ installId: "install-1" }),
    ).resolves.toBeNull();
  });

  it("reads a self-hosted server's retention", async () => {
    const fetchAdmin = vi.fn(async (path: string) =>
      path === "/retention"
        ? Response.json({ rawDays: 30, dailyDays: 60 })
        : Response.json({ data: [], nextCursor: null }),
    );
    const reads = await requireFeature(
      createConsoleRuntime({
        database: remoteDatabase(fetchAdmin),
        plugins: [insights()],
      }),
      "insights",
    );

    await expect(reads.getRetention()).resolves.toEqual({
      rawDays: 30,
      dailyDays: 60,
    });
  });
});
