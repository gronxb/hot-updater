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
  installId: "install-1",
  platform: "ios",
  toBundleId: "bundle-1",
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

describe("createHotUpdater Analytics", () => {
  it.each([undefined, false] as const)(
    "keeps Analytics routes absent when the feature is %s",
    async (analytics) => {
      const hotUpdater = createHotUpdater({
        database: createInMemoryDatabasePlugin(),
        ...(analytics === undefined ? {} : { features: { analytics } }),
      });

      expect(hotUpdater.analytics).toBeUndefined();
      expect((await hotUpdater.handlers.client(eventRequest())).status).toBe(
        404,
      );
      expect(
        (
          await hotUpdater.handlers.admin(
            new Request("https://example.com/installations/overview"),
          )
        ).status,
      ).toBe(404);
    },
  );

  it("persists events through the official database domain and serves queries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const database = createInMemoryDatabasePlugin();
    const append = vi.spyOn(database.models.analytics, "append");
    const hotUpdater = createHotUpdater({
      features: { analytics: true },
      database,
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
    expect(hotUpdater.analytics).toMatchObject({
      mode: "bounded",
      maxMatchingRows: 50_000,
    });
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toEqual({
      bundles: [{ bundleId: "bundle-1", installations: 1 }],
      trackedInstallations: 1,
    });
  });

  it("checks the official schema before Analytics reads and writes", async () => {
    const database = createSchemaManagedDatabase(
      "kysely",
      HOT_UPDATER_SCHEMA_VERSION,
    );
    const createMigrator = vi.spyOn(database, "createMigrator");
    const hotUpdater = createHotUpdater({
      features: { analytics: true },
      database,
    });

    expect((await hotUpdater.handlers.client(eventRequest())).status).toBe(204);
    await hotUpdater.analytics?.getBundleEventOverview();

    expect(createMigrator).toHaveBeenCalledOnce();
  });

  it("keeps ingestion and queries on separate handler surfaces", async () => {
    const hotUpdater = createHotUpdater({
      features: { analytics: true },
      database: createInMemoryDatabasePlugin(),
    });

    expect((await hotUpdater.handlers.client(eventRequest())).status).toBe(204);
    const clientQuery = await hotUpdater.handlers.client(
      new Request("https://example.com/installations/overview"),
    );
    const adminIngestion = await hotUpdater.handlers.admin(eventRequest());
    const adminQuery = await hotUpdater.handlers.admin(
      new Request("https://example.com/installations/overview"),
    );

    expect(clientQuery.status).toBe(404);
    expect(adminIngestion.status).toBe(404);
    expect(adminQuery.status).toBe(200);
    expect(adminQuery.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns a stable client error for malformed event payloads", async () => {
    const hotUpdater = createHotUpdater({
      features: { analytics: true },
      database: createInMemoryDatabasePlugin(),
    });

    const response = await hotUpdater.handlers.client(
      eventRequest({ ...event, platform: "web" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid event field: platform",
    });
  });

  it("rejects a non-boolean Analytics feature", () => {
    expect(() =>
      createHotUpdater({
        features: { analytics: "enabled" as unknown as boolean },
        database: createInMemoryDatabasePlugin(),
      }),
    ).toThrow("Analytics feature must be a boolean.");
  });
});
