// @vitest-environment node

import type { BundleEventRow } from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { createDatabasePluginApis } from "@hot-updater/server/db";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import { describe, expect, it, vi } from "vitest";

import { InsightsOffError } from "./adminInsights";
import { createConsoleRuntime, requireInsightsModel } from "./runtime.server";

const engineDatabase = () => ({
  name: "memory",
  adapter: createMemoryAdapter(),
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
      username: null,
      cohort: "1",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: null,
    },
    received_at_ms: Date.now(),
  }) as BundleEventRow;

describe("createConsoleRuntime", () => {
  it("runs the listed plugins over the database, as the server does", async () => {
    const database = engineDatabase();
    const runtime = createConsoleRuntime({
      database,
      plugins: [insights(), apiKeys()],
    });

    await expect(runtime.insights.status()).resolves.toBe("on");
    const model = await requireInsightsModel(runtime.insights);
    await model.recordEvent({
      event: event("01900000-0000-7000-8000-000000000001"),
    });
    await expect(
      runtime.insights.reads.getInstallation({ installId: "install-1" }),
    ).resolves.toMatchObject({ installId: "install-1" });

    const created = await runtime.apiKeys!.create({ name: "Console" });
    // The server's own tables: the server's apiKeys() plugin sees the same key.
    await expect(
      createDatabasePluginApis(database, [apiKeys()]).apiKeys.list(),
    ).resolves.toEqual([
      expect.objectContaining({ id: created.record.id, name: "Console" }),
    ]);
  });

  it("turns a plugin that is not listed off", async () => {
    const runtime = createConsoleRuntime({
      database: engineDatabase(),
      plugins: [],
    });

    await expect(runtime.insights.status()).resolves.toBe("off");
    await expect(
      runtime.insights.reads.listEvents({ limit: 1 }),
    ).rejects.toBeInstanceOf(InsightsOffError);
    await expect(requireInsightsModel(runtime.insights)).rejects.toBeInstanceOf(
      InsightsOffError,
    );
    expect(runtime.apiKeys).toBeNull();
  });

  it("turns Insights and API keys off without plugins", async () => {
    const runtime = createConsoleRuntime({ database: engineDatabase() });

    await expect(runtime.insights.status()).resolves.toBe("off");
    expect(runtime.apiKeys).toBeNull();
  });

  it("asks a self-hosted server whether it runs Insights, and manages no keys", async () => {
    const fetchAdmin = vi.fn(async (path: string) =>
      path.startsWith("/events")
        ? new Response(null, {
            status: 204,
            headers: { "x-hot-updater-insights": "disabled" },
          })
        : Response.json({}),
    );
    const runtime = createConsoleRuntime({
      database: { name: "standalone-repository", core: {}, fetchAdmin },
    });

    await expect(runtime.insights.status()).resolves.toBe("off");
    expect(fetchAdmin).toHaveBeenCalledWith("/events?limit=1");
    expect(runtime.insights.model).toBeNull();
    expect(runtime.apiKeys).toBeNull();
  });

  it("reads a self-hosted server's Insights through its admin routes", async () => {
    const fetchAdmin = vi.fn(async (path: string) =>
      path.startsWith("/installations/")
        ? Response.json({ installId: "install-1" })
        : Response.json({ data: [], nextCursor: null }),
    );
    const runtime = createConsoleRuntime({
      database: { core: {}, fetchAdmin },
    });

    await expect(runtime.insights.status()).resolves.toBe("on");
    await runtime.insights.reads.listEvents({
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
      runtime.insights.reads.getInstallation({ installId: "install 1" }),
    ).resolves.toEqual({ installId: "install-1" });
    expect(fetchAdmin).toHaveBeenLastCalledWith("/installations/install%201");
    await expect(requireInsightsModel(runtime.insights)).rejects.toThrow(
      "a self-hosted server does not serve them over its admin API",
    );
  });
});
