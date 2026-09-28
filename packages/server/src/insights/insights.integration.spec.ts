import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { builtInSettings } from "../db/builtInDatabase";
import { createHotUpdater } from "../index";
import { insights } from "../plugins/insights";
import {
  createFencedDatabase,
  createRuntimeDatabase,
} from "../runtime.testFixtures";
import { EVENT_BODY_MAX_BYTES } from "./eventInput";

/** A server with the Insights plugin on an empty in-memory database. */
const start = () =>
  createHotUpdater({
    database: createRuntimeDatabase(),
    plugins: [insights()],
    clientAccess: "public",
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
  it("ingests a downloaded bundle and exposes the running and pending state until apply", async () => {
    const hotUpdater = start();
    const downloaded = {
      ...event,
      type: "UPDATE_DOWNLOADED",
      fromBundleId: "bundle-1",
      toBundleId: "bundle-2",
      toReleaseId: "release-2",
      updateStrategy: "appVersion",
    };
    expect(
      (await hotUpdater.handlers.client(eventRequest(downloaded))).status,
    ).toBe(204);
    const downloads = await hotUpdater.handlers.admin(
      new Request(
        `https://example.com/events?platform=ios&channel=production&bundleId=bundle-2&outcome=downloaded&beforeReceivedAtMs=${Date.now() + 1}`,
      ),
    );
    expect(downloads.status).toBe(200);
    await expect(downloads.json()).resolves.toMatchObject({
      data: [{ type: "UPDATE_DOWNLOADED", toBundleId: "bundle-2" }],
    });
    const lookup = () =>
      hotUpdater.handlers.admin(
        new Request("https://example.com/installations/install-1"),
      );
    await expect((await lookup()).json()).resolves.toMatchObject({
      latestStatus: "UPDATE_DOWNLOADED",
      lastKnownBundleId: "bundle-1",
      pendingBundleId: "bundle-2",
      pendingReleaseId: "release-2",
    });
    expect(
      (
        await hotUpdater.handlers.client(
          eventRequest({ ...downloaded, type: "UPDATE_APPLIED" }),
        )
      ).status,
    ).toBe(204);
    await expect((await lookup()).json()).resolves.toMatchObject({
      latestStatus: "UPDATE_APPLIED",
      lastKnownBundleId: "bundle-2",
      pendingBundleId: null,
      pendingReleaseId: null,
    });
    expect(
      (
        await hotUpdater.handlers.client(
          eventRequest({ ...downloaded, fromBundleId: null }),
        )
      ).status,
    ).toBe(400);
  });

  it("persists an event and serves the lean Insights views", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const receivedAtMs = Date.now();
    const hotUpdater = start();
    const append = vi.spyOn(hotUpdater.api.insights, "recordEvent");

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
      new Request(
        "https://example.com/overview?platform=ios&channel=production&window=24h",
      ),
    );

    expect(ingestion.status).toBe(204);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        install_id: "install-1",
        metadata: expect.objectContaining({ sdk_version: "2.0.0" }),
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
    // Whole hours, ending with the current one.
    const end = Date.parse("2026-08-12T01:00:00.000Z");
    await expect(active.json()).resolves.toEqual({
      platform: "ios",
      channel: "production",
      sinceMs: end - 24 * 60 * 60 * 1_000,
      beforeReceivedAtMs: end,
      reportingInstallations: { count: 1, measuredAtMs: Date.now() },
      window: "24h",
    });
  });

  it("serves scoped bundle counts and the same half-open recovery drill-down", async () => {
    vi.useFakeTimers();
    const hotUpdater = start();
    const report = async (
      receivedAtMs: number,
      overrides: Record<string, unknown>,
    ) => {
      vi.setSystemTime(receivedAtMs);
      const response = await hotUpdater.handlers.client(
        eventRequest({ ...event, ...overrides }),
      );
      expect(response.status).toBe(204);
    };
    await report(100, {
      type: "UPDATE_APPLIED",
      fromBundleId: "A",
      toBundleId: "B",
      updateStrategy: "appVersion",
    });
    await report(200, {
      type: "RECOVERED",
      fromBundleId: "B",
      toBundleId: "A",
      updateStrategy: "appVersion",
    });
    await report(300, {
      installId: "install-2",
      type: "UNCHANGED",
      fromBundleId: null,
      toBundleId: "B",
      updateStrategy: null,
    });
    await report(400, {
      installId: "install-3",
      platform: "android",
      toBundleId: "B",
    });
    vi.setSystemTime(500);
    const overview = await hotUpdater.handlers.admin(
      new Request(
        "https://example.com/overview?platform=ios&channel=production&window=24h&bundleId=B",
      ),
    );
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toMatchObject({
      sinceMs: 0,
      beforeReceivedAtMs: 60 * 60 * 1_000,
      reportingInstallations: { count: 2 },
      bundle: {
        bundleId: "B",
        reportingInstallations: { count: 1 },
        appliedReports: { count: 1 },
        recoveredReports: { count: 1 },
        unchangedReports: { count: 1 },
      },
    });
    const drilldown = await hotUpdater.handlers.admin(
      new Request(
        "https://example.com/events?platform=ios&channel=production&bundleId=B&outcome=recovered&sinceMs=200&beforeReceivedAtMs=300",
      ),
    );
    await expect(drilldown.json()).resolves.toMatchObject({
      data: [
        {
          type: "RECOVERED",
          fromBundleId: "B",
          toBundleId: "A",
          receivedAtMs: 200,
        },
      ],
      nextCursor: null,
    });
    const outside = await hotUpdater.handlers.admin(
      new Request(
        "https://example.com/events?platform=ios&channel=production&bundleId=B&outcome=recovered&sinceMs=0&beforeReceivedAtMs=200",
      ),
    );
    await expect(outside.json()).resolves.toMatchObject({
      data: [],
      nextCursor: null,
    });
  });

  it.each([
    "/overview?window=24h",
    "/overview?platform=ios&channel=production&platform=android",
    "/events?bundleId=B",
    "/events?platform=ios&channel=production&bundleId=B&outcome=UNCHANGED",
    "/events?sinceMs=20&beforeReceivedAtMs=10",
    // 90 days and 1 ms, longer than a bundle list covers.
    "/events?platform=ios&channel=production&bundleId=B&outcome=applied&sinceMs=0&beforeReceivedAtMs=7776000001",
    "/installations/install-1/events?platform=ios&channel=production&bundleId=B&outcome=applied",
  ])("rejects ambiguous or invalid Insights query %s", async (path) => {
    const hotUpdater = start();
    expect(
      (
        await hotUpdater.handlers.admin(
          new Request(`https://example.com${path}`),
        )
      ).status,
    ).toBe(400);
  });

  it("lists at most 90 days of events, and says so for a longer range", async () => {
    const hotUpdater = start();
    const range = "sinceMs=0&beforeReceivedAtMs=7776000001";
    const events = await hotUpdater.handlers.admin(
      new Request(`https://example.com/events?${range}`),
    );
    expect(events.status).toBe(400);
    await expect(events.json()).resolves.toEqual({
      error:
        "Insights event lists cover at most 90 days: send a sinceMs no more than 90 days before beforeReceivedAtMs.",
    });
    // An installation's history is one index range, however long.
    const history = await hotUpdater.handlers.admin(
      new Request(
        `https://example.com/installations/install-1/events?${range}`,
      ),
    );
    expect(history.status).toBe(200);
  });

  it("checks the schema settings before Insights reads and writes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unmigrated = createHotUpdater({
      database: await createFencedDatabase("kysely"),
      plugins: [insights()],
      clientAccess: "public",
    });
    const migrated = createHotUpdater({
      database: await createFencedDatabase("kysely", builtInSettings),
      plugins: [insights()],
      clientAccess: "public",
    });

    expect((await unmigrated.handlers.client(eventRequest())).status).toBe(503);
    expect((await migrated.handlers.client(eventRequest())).status).toBe(204);
    error.mockRestore();
  });

  it("keeps ingestion and queries on separate handler surfaces", async () => {
    const hotUpdater = start();

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

  it("records same-file selection as no change and rejects a fourth event type", async () => {
    const hotUpdater = start();
    const recordEvent = vi.spyOn(hotUpdater.api.insights, "recordEvent");
    const selection = {
      ...event,
      fromReleaseId: "previous-release",
      toReleaseId: "selected-release",
    };
    expect(
      (await hotUpdater.handlers.client(eventRequest(selection))).status,
    ).toBe(204);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "UNCHANGED",
        from_bundle_id: null,
        metadata: expect.objectContaining({ update_strategy: null }),
        from_release_id: "previous-release",
        to_release_id: "selected-release",
        to_bundle_id: event.toBundleId,
      }),
    );
    const response = await hotUpdater.handlers.client(
      eventRequest({
        ...selection,
        type: "RELEASE_ADOPTED",
        fromBundleId: event.toBundleId,
        updateStrategy: "appVersion",
      }),
    );
    expect(response.status).toBe(400);
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it("returns a stable client error for malformed event payloads", async () => {
    const hotUpdater = start();

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
      const hotUpdater = start();

      const response = await hotUpdater.handlers.client(
        eventRequest({ ...event, [field]: "x".repeat(256) }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: `Invalid event field: ${field}`,
      });
    },
  );

  it("preserves a leading Unicode BOM in exact installation and current-user IDs", async () => {
    const hotUpdater = start();
    const installId = "\uFEFFinstall";
    const userId = "\uFEFFuser";
    expect(
      (
        await hotUpdater.handlers.client(
          eventRequest({ ...event, installId, userId }),
        )
      ).status,
    ).toBe(204);
    const installation = await hotUpdater.handlers.admin(
      new Request(
        `https://example.com/installations/${encodeURIComponent(installId)}`,
      ),
    );
    expect(installation.status).toBe(200);
    await expect(installation.json()).resolves.toMatchObject({
      installId,
      userId,
    });
    const matches = await hotUpdater.handlers.admin(
      new Request(
        `https://example.com/installations?userId=${encodeURIComponent(userId)}`,
      ),
    );
    expect(matches.status).toBe(200);
    await expect(matches.json()).resolves.toMatchObject({
      data: [{ installId, userId }],
    });
  });

  it.each(["\uD800", "\uDC00"])(
    "rejects an unmatched surrogate identity %j",
    async (installId) => {
      const hotUpdater = start();
      expect(
        (
          await hotUpdater.handlers.client(
            eventRequest({ ...event, installId }),
          )
        ).status,
      ).toBe(400);
    },
  );

  it("rejects 256-character installation query identities", async () => {
    const hotUpdater = start();
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
      const hotUpdater = start();
      const payload: Record<string, unknown> = { ...event };
      delete payload[field];

      const response = await hotUpdater.handlers.client(eventRequest(payload));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: `Invalid event field: ${field}`,
      });
    },
  );

  it("records a report with fields it does not know and still checks the ones it does", async () => {
    const hotUpdater = start();
    const newer = { ...event, networkType: "wifi", screen: { width: 390 } };

    expect((await hotUpdater.handlers.client(eventRequest(newer))).status).toBe(
      204,
    );
    const installation = await hotUpdater.handlers.admin(
      new Request("https://example.com/installations/install-1"),
    );
    await expect(installation.json()).resolves.toMatchObject({
      installId: "install-1",
      latestStatus: "UNCHANGED",
    });
    const invalid = await hotUpdater.handlers.client(
      eventRequest({ ...newer, channel: 7 }),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      error: "Invalid event field: channel",
    });
    const tooLarge = await hotUpdater.handlers.client(
      eventRequest({ ...newer, padding: "x".repeat(EVENT_BODY_MAX_BYTES) }),
    );
    expect(tooLarge.status).toBe(413);
  });

  it("counts a retried report once under its client event ID and refuses the ID to another installation", async () => {
    const hotUpdater = start();
    const eventId = "01987a6e-4c00-7abc-8def-0123456789ab";
    const report = { ...event, eventId };
    const counts = async () => {
      const overview = await hotUpdater.handlers.admin(
        new Request(
          "https://example.com/overview?platform=ios&channel=production&window=24h&bundleId=bundle-1",
        ),
      );
      return (
        (await overview.json()) as {
          readonly bundle: { readonly unchangedReports: { count: number } };
        }
      ).bundle.unchangedReports.count;
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        (await hotUpdater.handlers.client(eventRequest(report))).status,
      ).toBe(204);
    }
    await expect(counts()).resolves.toBe(1);
    const events = await hotUpdater.handlers.admin(
      new Request(
        `https://example.com/events?beforeReceivedAtMs=${Date.now() + 1}`,
      ),
    );
    await expect(events.json()).resolves.toMatchObject({
      data: [{ id: eventId, installId: "install-1" }],
    });

    const conflict = await hotUpdater.handlers.client(
      eventRequest({ ...report, installId: "install-2" }),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: `Event ${eventId} is already recorded for another installation.`,
    });
    expect(
      (
        await hotUpdater.handlers.admin(
          new Request("https://example.com/installations/install-2"),
        )
      ).status,
    ).toBe(404);

    // Without an ID the server creates one, so each report counts.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        (await hotUpdater.handlers.client(eventRequest(event))).status,
      ).toBe(204);
    }
    await expect(counts()).resolves.toBe(3);
  });

  it.each([
    "event-1",
    "01987A6E-4C00-7ABC-8DEF-0123456789AB",
    "01987a6e-4c00-4abc-8def-0123456789ab",
    null,
  ])("rejects the event ID %j", async (eventId) => {
    const hotUpdater = start();

    const response = await hotUpdater.handlers.client(
      eventRequest({ ...event, eventId }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid event field: eventId",
    });
  });

  it("answers 503 with Retry-After while the database is busy, and 500 when it fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const on = (overrides: Partial<DatabaseAdapter>) =>
      createHotUpdater({
        database: {
          name: "testDatabase",
          adapter: { ...createMemoryAdapter(), ...overrides },
        },
        plugins: [insights()],
        clientAccess: "public",
      }).handlers.client(eventRequest());
    const throttled = Object.assign(
      new Error("The level of configured provisioned throughput was exceeded."),
      { name: "ProvisionedThroughputExceededException" },
    );

    // Every write is refused as transient until the engine runs out of retries.
    const busy = await on({ write: async () => ({ ok: false, retry: true }) });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    await expect(busy.json()).resolves.toEqual({
      error: "Service unavailable",
    });
    // A throttled read throws the backend's own error.
    const throttledRead = await on({
      get: async () => {
        throw throttled;
      },
    });
    expect(throttledRead.status).toBe(503);
    expect(throttledRead.headers.get("retry-after")).toBe("5");
    const failed = await on({
      get: async () => {
        throw new Error("connection refused");
      },
    });
    expect(failed.status).toBe(500);
    expect(failed.headers.get("retry-after")).toBeNull();
    // Each 503 warns, and only the failure logs as an error.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    warn.mockRestore();
  });
});
