import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it, vi } from "vitest";

import { analytics } from "./analytics";
import type { AnalyticsProvider } from "./provider";

const database = createDatabasePlugin({
  name: "analytics-kernel-test",
  plugin: () => ({
    async create() {
      throw new TypeError("core database is outside this scenario");
    },
    async update() {
      throw new TypeError("core database is outside this scenario");
    },
    async delete() {
      throw new TypeError("core database is outside this scenario");
    },
    async count() {
      throw new TypeError("core database is outside this scenario");
    },
    async findOne() {
      throw new TypeError("core database is outside this scenario");
    },
    async findMany() {
      throw new TypeError("core database is outside this scenario");
    },
  }),
});

const appendBundleEvent = vi.fn(async () => undefined);

const provider = Object.freeze({
  mode: "dedicated",
  appendBundleEvent,
  async getBundleEventSummary() {
    return { installed: 0, recovered: 0 };
  },
  async getBundleEventAnalytics(_bundleId, _window, limit, offset) {
    return {
      summary: { installed: 0, recovered: 0 },
      series: { installed: [], recovered: [] },
      cohorts: { installed: [], recovered: [] },
      recentEvents: {
        data: [],
        pagination: { total: 0, limit, offset },
      },
    };
  },
  async getBundleEventOverview() {
    return {
      trackedInstallations: 1,
      bundles: [{ bundleId: "bundle-1", installations: 1 }],
    };
  },
  async getActiveInstallationOverview(input) {
    return {
      asOfMs: 1,
      window: input.window,
      activeInstallations: 0,
      series: [],
      bundleSeries: [],
      bundles: [],
    };
  },
  async searchInstallations(_query, limit, offset) {
    return { data: [], pagination: { total: 0, limit, offset } };
  },
  async getInstallationHistory(_installId, limit, offset) {
    return { data: [], pagination: { total: 0, limit, offset } };
  },
} satisfies AnalyticsProvider);

describe("Analytics plugin through createHotUpdater", () => {
  it("ingests an event and serves a public query through the Kernel", async () => {
    appendBundleEvent.mockClear();
    const hotUpdater = createHotUpdater({
      database,
      plugins: [analytics({ provider, queryAccess: "public" })],
    });
    const event = {
      type: "UNCHANGED",
      installId: "install-1",
      toBundleId: "bundle-1",
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "default",
      fingerprintHash: null,
      fromBundleId: null,
      updateStrategy: null,
    } as const;

    const ingestion = await hotUpdater.handler(
      new Request("https://example.com/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "hot-updater-sdk-version": "2.0.0",
        },
        body: JSON.stringify(event),
      }),
    );
    const overview = await hotUpdater.handler(
      new Request("https://example.com/api/installations/overview"),
    );

    expect(ingestion.status).toBe(204);
    expect(appendBundleEvent).toHaveBeenCalledWith({
      ...event,
      sdkVersion: "2.0.0",
    });
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toEqual({
      trackedInstallations: 1,
      bundles: [{ bundleId: "bundle-1", installations: 1 }],
    });
  });

  it("does not freeze a stateful explicit provider", async () => {
    const statefulProvider = {
      ...provider,
      appendCount: 0,
      async appendBundleEvent() {
        this.appendCount += 1;
      },
    };
    const hotUpdater = createHotUpdater({
      database,
      plugins: [
        analytics({ provider: statefulProvider, queryAccess: "public" }),
      ],
    });

    const response = await hotUpdater.handler(
      new Request("https://example.com/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "UNCHANGED",
          installId: "stateful-install",
          toBundleId: "bundle-1",
          platform: "ios",
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          fingerprintHash: null,
          fromBundleId: null,
          updateStrategy: null,
        }),
      }),
    );

    expect(response.status).toBe(204);
    expect(statefulProvider.appendCount).toBe(1);
  });
});
