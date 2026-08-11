import {
  attachUniversalComponentDataAdapter,
  createDatabasePlugin,
  UniversalComponentDataStateNotReadyError,
  UniversalComponentSchemaNotReadyError,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it, vi } from "vitest";

import { analytics } from "./analytics";
import { analyticsComponentSchema } from "./componentSchema";
import type { AnalyticsProvider } from "./provider";

const createTestDatabase = () =>
  createDatabasePlugin({
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

const database = createTestDatabase();
const assertComponentReady = vi.fn(async () => undefined);
const appendComponentRow = vi.fn(async () => {
  await assertComponentReady();
});
const componentDatabase = attachUniversalComponentDataAdapter(
  createTestDatabase(),
  () => ({
    bind(schema) {
      if (schema !== analyticsComponentSchema) {
        throw new TypeError("unexpected component schema");
      }
      return {
        schema,
        append: appendComponentRow,
        assertReady: assertComponentReady,
        create: async () => "created",
        get: async () => null,
        orderedScan: async () => {
          await assertComponentReady();
          return [];
        },
      };
    },
  }),
);
const notReadyComponentDatabase = attachUniversalComponentDataAdapter(
  createTestDatabase(),
  () => ({
    bind(schema) {
      const markerNotReady = (): never => {
        throw new UniversalComponentSchemaNotReadyError(
          analyticsComponentSchema.id,
          "2",
          "1",
        );
      };
      const dataNotReady = (): never => {
        throw new UniversalComponentDataStateNotReadyError(
          analyticsComponentSchema.id,
          "2",
          "stored-data",
        );
      };
      return {
        schema,
        append: async () => markerNotReady(),
        assertReady: async () => dataNotReady(),
        create: async () => markerNotReady(),
        get: async () => dataNotReady(),
        orderedScan: async () => dataNotReady(),
      };
    },
  }),
);

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
  it("uses the database's neutral component source by default", async () => {
    appendComponentRow.mockClear();
    assertComponentReady.mockClear();
    const hotUpdater = createHotUpdater({
      database: componentDatabase,
      plugins: [analytics({ queryAccess: "public" })],
    });

    const response = await hotUpdater.handler(
      new Request("https://example.com/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          fingerprintHash: null,
          fromBundleId: null,
          installId: "component-install",
          platform: "ios",
          toBundleId: "00000000-0000-4000-8000-000000000002",
          type: "UNCHANGED",
          updateStrategy: null,
        }),
      }),
    );

    expect(response.status).toBe(204);
    expect(appendComponentRow).toHaveBeenCalledWith({
      row: expect.objectContaining({
        install_id: "component-install",
        to_bundle_id: "00000000-0000-4000-8000-000000000002",
        type: "UNCHANGED",
      }),
      table: "bundle_events",
    });

    const overview = await hotUpdater.handler(
      new Request("https://example.com/api/installations/overview"),
    );
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toEqual({
      bundles: [],
      trackedInstallations: 0,
    });
    expect(assertComponentReady).toHaveBeenCalled();
  });

  it("keeps default routes visible and returns the stable 503 for marker and data drift", async () => {
    const hotUpdater = createHotUpdater({
      database: notReadyComponentDatabase,
      plugins: [analytics({ queryAccess: "public" })],
    });
    const ingestion = await hotUpdater.handler(
      new Request("https://example.com/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          fingerprintHash: null,
          fromBundleId: null,
          installId: "not-ready-install",
          platform: "ios",
          toBundleId: "00000000-0000-4000-8000-000000000002",
          type: "UNCHANGED",
          updateStrategy: null,
        }),
      }),
    );
    const overview = await hotUpdater.handler(
      new Request("https://example.com/api/installations/overview"),
    );

    expect([ingestion.status, overview.status]).toEqual([503, 503]);
    await expect(ingestion.json()).resolves.toEqual({
      error: { code: "ANALYTICS_SCHEMA_NOT_READY" },
    });
    await expect(overview.json()).resolves.toEqual({
      error: { code: "ANALYTICS_SCHEMA_NOT_READY" },
    });
  });

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
