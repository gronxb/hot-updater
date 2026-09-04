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
  userId: "user-1",
  username: "Jane",
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
  it("persists an event and serves the lean Insights views", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const receivedAtMs = Date.now();
    const database = createInMemoryDatabasePlugin();
    const append = vi.spyOn(database.models.insights, "append");
    const hotUpdater = createHotUpdater({
      database,
      clientAccess: { type: "public" },
    });

    const ingestion = await hotUpdater.handlers.client(eventRequest());
    vi.advanceTimersByTime(1);
    const events = await hotUpdater.handlers.admin(
      new Request("https://example.com/events"),
    );
    const installation = await hotUpdater.handlers.admin(
      new Request("https://example.com/installations/install-1"),
    );
    const matches = await hotUpdater.handlers.admin(
      new Request("https://example.com/installations?userId=user-1"),
    );
    const active = await hotUpdater.handlers.admin(
      new Request("https://example.com/installations/active?window=24h"),
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
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      data: [
        {
          id: expect.any(String),
          installId: "install-1",
          receivedAtMs,
          type: "UNCHANGED",
          userId: "user-1",
          username: "Jane",
        },
      ],
      nextCursor: null,
    });
    expect(installation.status).toBe(200);
    await expect(installation.json()).resolves.toMatchObject({
      installId: "install-1",
      latestStatus: "UNCHANGED",
      userId: "user-1",
    });
    expect(matches.status).toBe(200);
    await expect(matches.json()).resolves.toMatchObject({
      data: [{ installId: "install-1", userId: "user-1" }],
      nextCursor: null,
    });
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toEqual({
      activeInstallations: 1,
      asOfMs: Date.now(),
      window: "24h",
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
    await hotUpdater.insights.pageEvents({});

    expect(createMigrator).toHaveBeenCalledOnce();
  });

  it("keeps ingestion and queries on separate handler surfaces", async () => {
    const hotUpdater = createHotUpdater({
      database: createInMemoryDatabasePlugin(),
      clientAccess: { type: "public" },
    });

    expect((await hotUpdater.handlers.client(eventRequest())).status).toBe(204);
    const clientQuery = await hotUpdater.handlers.client(
      new Request("https://example.com/events"),
    );
    const adminIngestion = await hotUpdater.handlers.admin(eventRequest());
    const adminQuery = await hotUpdater.handlers.admin(
      new Request("https://example.com/events"),
    );

    expect(clientQuery.status).toBe(404);
    expect(adminIngestion.status).toBe(404);
    expect(adminQuery.status).toBe(200);
    expect(adminQuery.headers.get("cache-control")).toBe("private, no-store");
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
      error: "Invalid event field: platform",
    });
  });

  it.each(["installId", "userId"] as const)(
    "rejects a 256-character event %s",
    async (field) => {
      const hotUpdater = createHotUpdater({
        database: createInMemoryDatabasePlugin(),
        clientAccess: { type: "public" },
      });

      const response = await hotUpdater.handlers.client(
        eventRequest({ ...event, [field]: "x".repeat(256) }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: `Invalid event field: ${field}`,
      });
    },
  );

  it("rejects 256-character installation query identities", async () => {
    const hotUpdater = createHotUpdater({
      database: createInMemoryDatabasePlugin(),
      clientAccess: { type: "public" },
    });
    const tooLong = "x".repeat(256);

    const user = await hotUpdater.handlers.admin(
      new Request(`https://example.com/installations?userId=${tooLong}`),
    );
    const installation = await hotUpdater.handlers.admin(
      new Request(`https://example.com/installations/${tooLong}`),
    );

    expect(user.status).toBe(400);
    expect(installation.status).toBe(400);
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
        error: `Invalid event field: ${field}`,
      });
    },
  );
});
