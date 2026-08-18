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
  new Request("https://example.com/api/events", {
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
      expect((await hotUpdater.handler(eventRequest())).status).toBe(404);
    },
  );

  it("persists events through the official database domain and serves queries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const database = createInMemoryDatabasePlugin();
    const append = vi.spyOn(database.models.analytics, "append");
    const hotUpdater = createHotUpdater({
      features: { analytics: { queryAccess: "public" } },
      database,
    });

    const ingestion = await hotUpdater.handler(eventRequest());
    vi.advanceTimersByTime(1);
    const overview = await hotUpdater.handler(
      new Request("https://example.com/api/installations/overview"),
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
      features: { analytics: { queryAccess: "public" } },
      database,
    });

    expect((await hotUpdater.handler(eventRequest())).status).toBe(204);
    await hotUpdater.analytics?.getBundleEventOverview();

    expect(createMigrator).toHaveBeenCalledOnce();
  });

  it("keeps ingestion public while protected queries fail closed", async () => {
    const hotUpdater = createHotUpdater({
      features: { analytics: true },
      database: createInMemoryDatabasePlugin(),
    });

    expect((await hotUpdater.handler(eventRequest())).status).toBe(204);
    const query = await hotUpdater.handler(
      new Request("https://example.com/api/installations/overview"),
    );

    expect(query.status).toBe(401);
    expect(query.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns a stable client error for malformed event payloads", async () => {
    const hotUpdater = createHotUpdater({
      features: { analytics: { queryAccess: "public" } },
      database: createInMemoryDatabasePlugin(),
    });

    const response = await hotUpdater.handler(
      eventRequest({ ...event, platform: "web" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid event field: platform",
    });
  });

  it("rejects an invalid query access value instead of exposing queries", () => {
    expect(() =>
      createHotUpdater({
        features: { analytics: { queryAccess: "invalid" as "public" } },
        database: createInMemoryDatabasePlugin(),
      }),
    ).toThrow("Invalid Analytics queryAccess option.");
  });
});
