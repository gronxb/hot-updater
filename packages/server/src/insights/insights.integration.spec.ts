import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createHotUpdater } from "../index";
import { createSchemaManagedDatabase } from "../runtime.testFixtures";
import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";

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
  sdkVersion: "2.0.0",
} as const;

const eventRequest = (body: unknown = event) =>
  new Request("https://example.com/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("createHotUpdater Insights", () => {
  it("always persists events and exposes the five-method Insights model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const database = createInMemoryDatabasePlugin();
    const append = vi.spyOn(database.models.insights, "append");
    const hotUpdater = createHotUpdater({
      database,
      clientAccess: { type: "public" },
    });

    const ingestion = await hotUpdater.handlers.client(eventRequest());
    vi.advanceTimersByTime(1);
    const overview = await hotUpdater.handlers.admin(
      new Request("https://example.com/installations/overview"),
    );

    expect(ingestion.status).toBe(204);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        install_id: "install-1",
        sdk_version: "2.0.0",
        to_bundle_id: "bundle-1",
        type: "UNCHANGED",
      }),
    );
    expect(hotUpdater.insights).toMatchObject({
      append: expect.any(Function),
      pageEvents: expect.any(Function),
      pageInstallations: expect.any(Function),
      getReport: expect.any(Function),
      pageReport: expect.any(Function),
    });
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toEqual({
      state: "failed",
      versions: {
        schemaVersion: null,
        storageVersion: null,
        projectionGeneration: null,
        sourceGeneration: null,
      },
      error: { code: "storage-not-ready" },
    });
  });

  it("checks the official schema before Insights reads and writes", async () => {
    const database = createSchemaManagedDatabase(
      "kysely",
      HOT_UPDATER_SCHEMA_VERSION,
    );
    const createMigrator = vi.spyOn(database, "createMigrator");
    const hotUpdater = createHotUpdater({
      database,
      clientAccess: { type: "public" },
    });

    expect((await hotUpdater.handlers.client(eventRequest())).status).toBe(204);
    await hotUpdater.insights.getReport({
      query: { kind: "installationOverview" },
    });

    expect(createMigrator).toHaveBeenCalledOnce();
  });

  it("keeps ingestion and queries on separate handler surfaces", async () => {
    const hotUpdater = createHotUpdater({
      database: createInMemoryDatabasePlugin(),
      clientAccess: { type: "public" },
    });

    expect((await hotUpdater.handlers.client(eventRequest())).status).toBe(204);
    const clientQuery = await hotUpdater.handlers.client(
      new Request("https://example.com/installations/overview"),
    );
    const adminIngestion = await hotUpdater.handlers.admin(eventRequest());
    const adminQuery = await hotUpdater.handlers.admin(
      new Request("https://example.com/installations/overview"),
    );
    const adminEvents = await hotUpdater.handlers.admin(
      new Request("https://example.com/events"),
    );
    const adminInstallations = await hotUpdater.handlers.admin(
      new Request("https://example.com/installations?kind=all"),
    );
    const adminReportPage = await hotUpdater.handlers.admin(
      new Request(
        "https://example.com/insights/reports/publication-1?section=activeSeries",
      ),
    );
    const legacyEventPage = await hotUpdater.handlers.admin(
      new Request("https://example.com/insights/v1/events"),
    );
    const legacyInstallationHistory = await hotUpdater.handlers.admin(
      new Request("https://example.com/installations/install-1/events"),
    );

    expect(clientQuery.status).toBe(404);
    expect(adminIngestion.status).toBe(404);
    expect(adminQuery.status).toBe(200);
    expect(adminQuery.headers.get("cache-control")).toBe("private, no-store");
    expect([
      adminEvents.status,
      adminInstallations.status,
      adminReportPage.status,
    ]).toEqual([200, 200, 200]);
    expect(legacyEventPage.status).toBe(404);
    expect(legacyInstallationHistory.status).toBe(404);
  });

  it("returns a stable client error for malformed event payloads", async () => {
    const hotUpdater = createHotUpdater({
      database: createInMemoryDatabasePlugin(),
      clientAccess: { type: "public" },
    });

    const response = await hotUpdater.handlers.client(
      eventRequest({ ...event, platform: "web" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INSIGHTS_INVALID_QUERY" },
    });
  });

  it.each(["fromReleaseId", "toReleaseId"] as const)(
    "rejects an omitted %s instead of treating it as null",
    async (field) => {
      const hotUpdater = createHotUpdater({
        database: createInMemoryDatabasePlugin(),
        clientAccess: { type: "public" },
      });
      const payload: Record<string, unknown> = { ...event };
      delete payload[field];

      const response = await hotUpdater.handlers.client(eventRequest(payload));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "INSIGHTS_INVALID_QUERY" },
      });
    },
  );
});
