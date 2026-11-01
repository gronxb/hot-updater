import { DatabaseSync } from "node:sqlite";

import {
  createEngine,
  createKvAdapter,
  createMemoryAdapter,
  createSqlAdapter,
  type DatabaseAdapter,
  type HotUpdaterDatabase,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import {
  createMemoryKeyValueStore,
  createPluginTestHarness,
} from "@hot-updater/test-utils";
import { sqliteExecutor } from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateBundleEventRequest } from "./domain";
import { createBundleEventRow, parseBundleEventRequest } from "./eventInput";
import {
  createInsightsModel,
  createInsightsProvider,
  insights,
  insightsIdentity,
  type InsightsApi,
  type InsightsSchema,
} from "./index";

const utc = (text: string) => Date.parse(text);

/** The fixture: made 2026-10-14T23:30Z, arrived 2026-10-16T01:10Z, 25h40m later. */
const MADE = utc("2026-10-14T23:30:00Z");
const ARRIVED = utc("2026-10-16T01:10:00Z");
const AGE = 92_400_000;
const HOUR_72 = 259_200_000;
const YEAR = 31_536_000_000;

const CHART_START = utc("2026-10-12T00:00:00Z");
const CHART_END = utc("2026-10-17T00:00:00Z");

/** A UUIDv7 report ID whose time is `ms`, on whatever clock made it. */
const idAt = (ms: number, n: number) =>
  `${ms
    .toString(16)
    .padStart(12, "0")
    .replace(
      /^(.{8})(.{4})$/,
      "$1-$2",
    )}-7000-8000-${String(n).padStart(12, "0")}`;

const downloadBody = (n: number, extra: Record<string, unknown> = {}) => ({
  eventId: idAt(MADE, n),
  type: "UPDATE_DOWNLOADED",
  installId: "install-1",
  platform: "ios",
  appVersion: "1.0.0",
  channel: "production",
  cohort: "1",
  fingerprintHash: null,
  sdkVersion: "1.2.0",
  minBundleId: "builtin",
  fromBundleId: "bundle-1",
  fromReleaseId: "release-1",
  toBundleId: "bundle-2",
  toReleaseId: "release-2",
  updateStrategy: "appVersion",
  ...extra,
});

const appliedBody = (n: number, extra: Record<string, unknown> = {}) =>
  downloadBody(n, { type: "UPDATE_APPLIED", ...extra });

const unchangedBody = (n: number, extra: Record<string, unknown> = {}) =>
  downloadBody(n, {
    type: "UNCHANGED",
    fromBundleId: null,
    fromReleaseId: null,
    toBundleId: "bundle-1",
    toReleaseId: "release-1",
    updateStrategy: null,
    ...extra,
  });

const scope = { platform: "ios", channel: "production" } as const;
const downloads = {
  ...scope,
  type: "UPDATE_DOWNLOADED",
  toBundleId: "bundle-2",
} as const;

const backends: [string, () => DatabaseAdapter][] = [
  ["memory", () => createMemoryAdapter()],
  [
    "SQLite",
    () =>
      createSqlAdapter({
        executor: sqliteExecutor(new DatabaseSync(":memory:")),
      }),
  ],
  [
    "the key-value helper",
    () => createKvAdapter({ store: createMemoryKeyValueStore() }),
  ],
];

const asRequest = (body: Record<string, unknown>) =>
  body as unknown as CreateBundleEventRequest;

type ChartPoint = readonly [string, number];

/** Non-empty points of a series as literal UTC hours. */
const nonEmpty = (
  points: readonly { startMs: number; events: number }[],
): ChartPoint[] =>
  points.flatMap(({ startMs, events }) =>
    events === 0
      ? []
      : ([[new Date(startMs).toISOString(), events]] as ChartPoint[]),
  );

const toolsOf = (api: InsightsApi, db: HotUpdaterDatabase<InsightsSchema>) => {
  const provider = createInsightsProvider(createInsightsModel(api));
  const send = async (at: number, body: Record<string, unknown>) => {
    vi.setSystemTime(at);
    await provider.appendBundleEvent(asRequest(body));
  };
  /** What the Adoption chart reads, through the validated model. */
  const chart = async (start = CHART_START, end = CHART_END) =>
    nonEmpty(
      await createInsightsModel(api).countEventSeries({
        filter: downloads,
        timeRange: { start, end },
        intervalMs: 3_600_000,
      }),
    );
  const outcomeRows = async (type: string) =>
    (
      await db.findAggregates("insights_outcomes", {
        index: "byRef",
        where: { ...scope, type, bundle_ref: "to:bundle-2" },
        limit: 100,
      })
    ).rows.map(
      (row) =>
        [new Date(row.bucket_start_ms).toISOString(), row.events] as const,
    );
  const lifetimeDownloads = async () => {
    const { data } = await api.getReleaseActivity({
      releases: [{ releaseId: "release-2", ...scope }],
    });
    return data[0]!.metrics.downloads;
  };
  /**
   * The series as a reader from before this rule computes it: one read of
   * the download rows, with no correction rows. A server still on that code
   * shares the database during a rollout, so its numbers must not move.
   */
  const oldReaderSeries = async () =>
    outcomeRows("UPDATE_DOWNLOADED").then((rows) => [...rows]);
  return { send, chart, outcomeRows, lifetimeDownloads, oldReaderSeries };
};

describe.each(backends)("a download's chart hour on %s", (_name, make) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = async (
    options: Parameters<typeof insights>[0] = {},
    adapter = make(),
  ) => {
    const harness = await createPluginTestHarness(insights(options), {
      adapter,
      now: () => Date.now(),
    });
    const db = harness.db as HotUpdaterDatabase<InsightsSchema>;
    return { api: harness.api, db, ...toolsOf(harness.api, db) };
  };

  it("charts a late download at the hour it happened and leaves all else on arrival", async () => {
    const { api, send, chart, lifetimeDownloads, outcomeRows } = await setup();
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));

    expect(await chart()).toEqual([["2026-10-14T23:00:00.000Z", 1]]);
    expect(await lifetimeDownloads()).toBe(1);

    // Raw row and head stay on arrival.
    const [head] = await api.findLatestEvents({ installId: "install-1" });
    expect(head!.received_at_ms).toBe(utc("2026-10-16T01:10:00Z"));
    const listed = await api.listEvents({
      filter: { kind: "bundle", ...downloads },
      sinceMs: utc("2026-10-10T00:00:00Z"),
      beforeReceivedAtMs: utc("2026-10-20T00:00:00Z"),
      limit: 5,
    });
    expect(listed.map((row) => row.received_at_ms)).toEqual([
      utc("2026-10-16T01:10:00Z"),
    ]);
    expect(listed[0]!.metadata.occurred_at_ms).toBe(
      utc("2026-10-14T23:30:00Z"),
    );

    // The arrival row stays, with its correction beside it.
    expect(await outcomeRows("UPDATE_DOWNLOADED")).toEqual([
      ["2026-10-16T01:00:00.000Z", 1],
    ]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_OUT")).toEqual([
      ["2026-10-16T01:00:00.000Z", 1],
    ]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_IN")).toEqual([
      ["2026-10-14T23:00:00.000Z", 1],
    ]);
  });

  it("answers countEvents over any range as if nothing moved", async () => {
    const { api, send } = await setup();
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
    const count = (since: string, before: string) =>
      api.countEvents({
        filter: downloads,
        sinceMs: utc(since),
        beforeReceivedAtMs: utc(before),
      });
    // Whole hours from the arrival row.
    expect(await count("2026-10-16T01:00:00Z", "2026-10-16T02:00:00Z")).toBe(1);
    expect(await count("2026-10-14T00:00:00Z", "2026-10-17T00:00:00Z")).toBe(1);
    // The hour it happened holds no arrival.
    expect(await count("2026-10-14T23:00:00Z", "2026-10-15T00:00:00Z")).toBe(0);
    // Partial edges from the raw row, by arrival.
    expect(await count("2026-10-16T01:00:00Z", "2026-10-16T01:30:00Z")).toBe(1);
    expect(await count("2026-10-14T23:15:00Z", "2026-10-14T23:45:00Z")).toBe(0);
  });

  it("keeps a moved download's gauges and latest event on its arrival day", async () => {
    const { api, send } = await setup();
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
    const reporting = (since: string) =>
      api.countLatestEvents({ ...scope, sinceMs: utc(since) });

    expect(await reporting("2026-10-16T00:00:00Z")).toBe(1);
    expect(await reporting("2026-10-17T00:00:00Z")).toBe(0);

    // The next report takes the gauge back from that same day.
    await send(utc("2026-10-18T09:00:00Z"), appliedBody(2));
    expect(await reporting("2026-10-16T00:00:00Z")).toBe(1);
    expect(await reporting("2026-10-18T00:00:00Z")).toBe(1);
  });

  it.each([
    ["an apply", appliedBody],
    ["a launch", unchangedBody],
  ])("refuses a stored time on %s", async (_label, body) => {
    const { api } = await setup();
    vi.setSystemTime(ARRIVED);
    const row = createBundleEventRow(asRequest(body(1)));
    await expect(
      createInsightsModel(api).recordEvent({
        event: {
          ...row,
          metadata: { ...row.metadata, occurred_at_ms: MADE },
        } as typeof row,
      }),
    ).rejects.toThrow();
  });

  it("refuses a stored time that is no safe integer", async () => {
    const { api } = await setup();
    vi.setSystemTime(ARRIVED);
    const row = createBundleEventRow(asRequest(downloadBody(1)));
    await expect(
      createInsightsModel(api).recordEvent({
        event: {
          ...row,
          metadata: { ...row.metadata, occurred_at_ms: 1.5 },
        } as typeof row,
      }),
    ).rejects.toThrow();
  });

  it("stays on arrival without an age (control)", async () => {
    const { send, chart, outcomeRows, api } = await setup();
    await send(ARRIVED, downloadBody(1));

    expect(await chart()).toEqual([["2026-10-16T01:00:00.000Z", 1]]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_OUT")).toEqual([]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_IN")).toEqual([]);
    const [head] = await api.findLatestEvents({ installId: "install-1" });
    expect(Object.hasOwn(head!.metadata, "occurred_at_ms")).toBe(false);
  });

  it.each([
    ["a year ahead", MADE + YEAR],
    ["a year behind", MADE - YEAR],
  ])(
    "gives the same hours from a device clock %s, never reading the id",
    async (_clock, idTime) => {
      const { send, chart } = await setup();
      await send(
        ARRIVED,
        downloadBody(1, { ageMs: AGE, eventId: idAt(idTime, 1) }),
      );
      expect(await chart()).toEqual([["2026-10-14T23:00:00.000Z", 1]]);
    },
  );

  it("stays on arrival when only the id is old (dating from the id would move it)", async () => {
    const { send, chart } = await setup();
    await send(ARRIVED, downloadBody(1, { eventId: idAt(MADE, 1) }));
    expect(await chart()).toEqual([["2026-10-16T01:00:00.000Z", 1]]);
  });

  it("moves a download exactly 72 hours old", async () => {
    const { send, chart } = await setup();
    await send(ARRIVED, downloadBody(1, { ageMs: HOUR_72 }));
    expect(await chart()).toEqual([["2026-10-13T01:00:00.000Z", 1]]);
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["negative", -1],
    ["one over 72 hours", HOUR_72 + 1],
    ["a fraction", 92_400_000.5],
    ["a string", "92400000"],
    ["null", null],
    ["true", true],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("stays on arrival when the age is %s", async (_label, ageMs) => {
    const { send, chart, outcomeRows, lifetimeDownloads } = await setup();
    await send(ARRIVED, downloadBody(1, ageMs === undefined ? {} : { ageMs }));
    expect(await chart()).toEqual([["2026-10-16T01:00:00.000Z", 1]]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_IN")).toEqual([]);
    expect(await lifetimeDownloads()).toBe(1);
  });

  it("writes no correction when the age stays inside the arrival hour", async () => {
    const { send, chart, outcomeRows } = await setup();
    // 01:10 less 60 seconds is still the 01:00 hour.
    await send(ARRIVED, downloadBody(1, { ageMs: 60_000 }));
    expect(await chart()).toEqual([["2026-10-16T01:00:00.000Z", 1]]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_OUT")).toEqual([]);
  });

  it.each([
    ["inside its arrival hour", "2026-10-16T01:05:00Z"],
    ["after its arrival", "2026-10-16T09:00:00Z"],
  ])(
    "writes no correction for a stored time %s",
    async (_label, occurredAt) => {
      const { api, chart, outcomeRows } = await setup();
      vi.setSystemTime(ARRIVED);
      const row = createBundleEventRow(asRequest(downloadBody(1)));
      await api.recordEvent({
        ...row,
        metadata: { ...row.metadata, occurred_at_ms: utc(occurredAt) },
      } as typeof row);
      expect(await chart()).toEqual([["2026-10-16T01:00:00.000Z", 1]]);
      expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_OUT")).toEqual([]);
    },
  );

  it("moves a download across the hour boundary, however small the age", async () => {
    const { send, chart } = await setup();
    await send(utc("2026-10-16T02:00:30Z"), downloadBody(1, { ageMs: 60_000 }));
    expect(await chart()).toEqual([["2026-10-16T01:00:00.000Z", 1]]);
  });

  it("dates no other report type by its age", async () => {
    const { api, db, send, outcomeRows } = await setup();
    await send(
      ARRIVED,
      downloadBody(1, {
        type: "UPDATE_FAILED",
        ageMs: AGE,
        metadata: { failure: { stage: "download", reason: "network" } },
      }),
    );
    expect(await outcomeRows("UPDATE_FAILED")).toEqual([
      ["2026-10-16T01:00:00.000Z", 1],
    ]);
    await send(ARRIVED + 1_000, appliedBody(2, { ageMs: AGE }));
    expect(await outcomeRows("UPDATE_APPLIED")).toEqual([
      ["2026-10-16T01:00:00.000Z", 1],
    ]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_IN")).toEqual([]);

    const hours = await api.getUpdateFailures({
      ...scope,
      timeRange: {
        start: utc("2026-10-16T01:00:00Z"),
        end: utc("2026-10-16T02:00:00Z"),
      },
    });
    expect(hours.failedUpdates).toBe(1);
    const failureRows = await db.findAggregates("insights_failures", {
      index: "byScope",
      where: scope,
      limit: 5,
    });
    expect(failureRows.rows.map((row) => row.bucket_start_ms)).toEqual([
      utc("2026-10-16T01:00:00Z"),
    ]);
  });

  it("counts one download on the no-reload path: UNCHANGED, late download, UPDATE_APPLIED", async () => {
    const { api, send, chart, lifetimeDownloads } = await setup();
    await send(utc("2026-10-15T12:00:00Z"), unchangedBody(1));
    await send(ARRIVED, downloadBody(2, { ageMs: AGE }));
    await send(ARRIVED + 60_000, appliedBody(3));

    expect(await lifetimeDownloads()).toBe(1);
    expect(await chart()).toEqual([["2026-10-14T23:00:00.000Z", 1]]);
    const [head] = await api.findLatestEvents({ installId: "install-1" });
    expect(head!.type).toBe("UPDATE_APPLIED");
    expect(head!.metadata.implied_download).toBeUndefined();
  });

  it("lets an implied download win over a report that arrives after it", async () => {
    const { send, chart, lifetimeDownloads, outcomeRows } = await setup();
    await send(utc("2026-10-15T12:00:00Z"), unchangedBody(1));
    await send(utc("2026-10-16T00:30:00Z"), appliedBody(2));
    await send(ARRIVED, downloadBody(3, { ageMs: AGE }));

    expect(await lifetimeDownloads()).toBe(1);
    expect(await chart()).toEqual([["2026-10-16T00:00:00.000Z", 1]]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_OUT")).toEqual([]);
  });

  it("keeps the launch of a day when a native UNCHANGED dated yesterday arrives first", async () => {
    const { db, send } = await setup();
    await send(
      utc("2026-10-16T08:00:00Z"),
      unchangedBody(1, { ageMs: 86_400_000 }),
    );
    await send(utc("2026-10-16T09:00:00Z"), unchangedBody(2));
    const usage = await db.findAggregates("insights_sketches_daily", {
      index: "window",
      where: {
        identity: insightsIdentity({
          scopeKind: "usage",
          releaseKind: "all",
          releaseId: "",
          channel: "production",
          platform: "ios",
          appVersionKind: "all",
          appVersion: "",
          periodKind: "day",
        }),
      },
      limit: 5,
    });
    expect(
      usage.rows.map((row) => new Date(row.bucket_start_ms).toISOString()),
    ).toEqual(["2026-10-16T00:00:00.000Z"]);
  });

  it("keeps the first commit when a retry after a handoff reports another age", async () => {
    const { send, chart, lifetimeDownloads } = await setup();
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
    await send(ARRIVED + 10 * 3_600_000, downloadBody(1, { ageMs: HOUR_72 }));

    expect(await lifetimeDownloads()).toBe(1);
    expect(await chart()).toEqual([["2026-10-14T23:00:00.000Z", 1]]);
  });

  it("falls back to arrival past rawDays: the hour it happened is already gone", async () => {
    const { send, chart, outcomeRows, lifetimeDownloads } = await setup({
      retention: { rawDays: 1, dailyDays: 1 },
    });
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));

    expect(await chart()).toEqual([["2026-10-16T01:00:00.000Z", 1]]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_OUT")).toEqual([]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_IN")).toEqual([]);
    expect(await lifetimeDownloads()).toBe(1);
  });

  it("moves it when rawDays still keeps the hour it happened", async () => {
    const { send, chart } = await setup({
      retention: { rawDays: 2, dailyDays: 2 },
    });
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
    expect(await chart()).toEqual([["2026-10-14T23:00:00.000Z", 1]]);
  });

  it("shows a window only what happened in it, when it holds one of the pair", async () => {
    const { send, chart } = await setup();
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
    await send(ARRIVED + 60_000, downloadBody(2, { installId: "install-2" }));

    // Only the arrival hour: the moved download is out, the normal one stays.
    expect(
      await chart(utc("2026-10-16T00:00:00Z"), utc("2026-10-17T00:00:00Z")),
    ).toEqual([["2026-10-16T01:00:00.000Z", 1]]);
    // Only the hour it happened.
    expect(
      await chart(utc("2026-10-14T00:00:00Z"), utc("2026-10-15T00:00:00Z")),
    ).toEqual([["2026-10-14T23:00:00.000Z", 1]]);
    // Both: each download once.
    expect(await chart()).toEqual([
      ["2026-10-14T23:00:00.000Z", 1],
      ["2026-10-16T01:00:00.000Z", 1],
    ]);
  });

  it("sums a day's interval to what happened that day", async () => {
    const { api, send } = await setup();
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
    const points = await api.countEventSeries({
      filter: downloads,
      timeRange: { start: CHART_START, end: CHART_END },
      intervalMs: 86_400_000,
    });
    expect(nonEmpty(points)).toEqual([["2026-10-14T00:00:00.000Z", 1]]);
  });

  it("never reads below zero when a correction landed without its download", async () => {
    const { db, chart } = await setup();
    await db.transaction(async (tx) => {
      tx.aggregate(
        "insights_outcomes",
        {
          ...scope,
          type: "UPDATE_DOWNLOADED_MOVED_OUT",
          bundle_ref: "to:bundle-2",
          bucket_start_ms: utc("2026-10-16T01:00:00Z"),
        },
        { events: 1 },
        { shardBy: "install-1" },
      );
    });
    expect(await chart()).toEqual([]);
  });

  it("leaves an older reader's series, counts, and lists as they were", async () => {
    const { api, send, oldReaderSeries, outcomeRows } = await setup();
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
    await send(
      utc("2026-10-16T05:00:00Z"),
      downloadBody(2, { installId: "install-2" }),
    );

    // Exactly the rows the same two downloads leave with no age at all.
    expect(await oldReaderSeries()).toEqual([
      ["2026-10-16T01:00:00.000Z", 1],
      ["2026-10-16T05:00:00.000Z", 1],
    ]);
    // Other filters never see a correction type.
    expect(await outcomeRows("UPDATE_APPLIED")).toEqual([]);
    // A list above a gap finds the arrival day from the same download row.
    const listed = await api.listEvents({
      filter: { kind: "bundle", ...downloads },
      sinceMs: utc("2026-10-01T00:00:00Z"),
      beforeReceivedAtMs: utc("2026-10-25T00:00:00Z"),
      limit: 5,
    });
    expect(listed.map((row) => row.received_at_ms)).toEqual([
      utc("2026-10-16T05:00:00Z"),
      utc("2026-10-16T01:10:00Z"),
    ]);
  });

  it("keeps the reads of a series that has no corrections to one, and a download's to three", async () => {
    const adapter = make();
    let queries = 0;
    const counted = Object.assign(Object.create(adapter) as DatabaseAdapter, {
      query: (...args: Parameters<DatabaseAdapter["query"]>) => {
        queries += 1;
        return adapter.query(...args);
      },
    });
    const { api, send } = await setup({}, counted);
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
    const series = (type: "UPDATE_DOWNLOADED" | "UPDATE_APPLIED") =>
      api.countEventSeries({
        filter: { ...downloads, type },
        timeRange: { start: CHART_START, end: CHART_END },
        intervalMs: 3_600_000,
      });

    queries = 0;
    await series("UPDATE_APPLIED");
    expect(queries).toBe(1);

    queries = 0;
    await series("UPDATE_DOWNLOADED");
    expect(queries).toBe(3);
  });
});

describe("a report's writes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** One report on a fresh database: every write and every read it took. */
  const measure = async (body: Record<string, unknown>) => {
    const inner = createMemoryAdapter();
    const seen = { writes: [] as string[], reads: 0 };
    const adapter = Object.assign(Object.create(inner) as DatabaseAdapter, {
      write: (ops: Parameters<DatabaseAdapter["write"]>[0]) => {
        seen.writes.push(...ops.map((op) => `${op.type} ${op.table.name}`));
        return inner.write(ops);
      },
      get: (...args: Parameters<DatabaseAdapter["get"]>) => {
        seen.reads += 1;
        return inner.get(...args);
      },
      query: (...args: Parameters<DatabaseAdapter["query"]>) => {
        seen.reads += 1;
        return inner.query(...args);
      },
    });
    const harness = await createPluginTestHarness(insights(), {
      adapter,
      now: () => Date.now(),
    });
    const provider = createInsightsProvider(createInsightsModel(harness.api));
    vi.setSystemTime(ARRIVED);
    seen.writes = [];
    seen.reads = 0;
    await provider.appendBundleEvent(asRequest(body));
    return seen;
  };

  const outcomeWrites = (writes: readonly string[]) =>
    writes.filter((write) => write.endsWith("insights_outcomes"));

  it("writes what it writes today for a report with no age, or one that stays in its hour", async () => {
    const normal = await measure(downloadBody(1));
    expect(outcomeWrites(normal.writes)).toEqual([
      "increment insights_outcomes",
      "increment insights_outcomes",
    ]);

    const sameHour = await measure(downloadBody(1, { ageMs: 60_000 }));
    expect(sameHour).toEqual(normal);

    const refused = await measure(downloadBody(1, { ageMs: HOUR_72 + 1 }));
    expect(refused).toEqual(normal);
  });

  it("adds exactly two writes and no read for a download moved to another hour", async () => {
    const normal = await measure(downloadBody(1));
    const moved = await measure(downloadBody(1, { ageMs: AGE }));

    expect(moved.writes).toHaveLength(normal.writes.length + 2);
    expect(outcomeWrites(moved.writes)).toEqual([
      "increment insights_outcomes",
      "increment insights_outcomes",
      "increment insights_outcomes",
      "increment insights_outcomes",
    ]);
    expect(moved.reads).toBe(normal.reads);
  });

  it("adds nothing for an aged report of another type", async () => {
    const normal = await measure(appliedBody(1));
    const aged = await measure(appliedBody(1, { ageMs: AGE }));
    expect(aged).toEqual(normal);
  });
});

/** The real engine, unlike the harness: pruning runs, and batching can be on. */
const engineWith = async (
  options: Parameters<typeof insights>[0],
  aggregateBatching?: { mode: "log" | "memory"; windowMs?: number },
) => {
  const adapter = aggregateBatching
    ? createKvAdapter({ store: createMemoryKeyValueStore() })
    : createMemoryAdapter();
  const plugin = insights(options);
  const tooling = toolingTargetOf([plugin]);
  await adapter.migrations?.apply(tooling.schema.tables);
  const engine = createEngine(
    {
      name: "test",
      adapter,
      ...(aggregateBatching ? { aggregateBatching } : {}),
    },
    { plugins: [plugin], now: () => Date.now() },
  );
  const db = engine.database(
    plugin,
  ) as unknown as HotUpdaterDatabase<InsightsSchema>;
  const { api } = plugin.init({
    db,
    core: {},
    now: () => Date.now(),
  } as never) as unknown as { api: InsightsApi };
  return { api, engine, db, ...toolsOf(api, db) };
};

describe("a download's chart hour on the real engine", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["log", "memory"] as const)(
    "nets a moved download with %s batching, before and after a flush",
    async (mode) => {
      const { engine, send, chart, lifetimeDownloads } = await engineWith(
        {},
        { mode, windowMs: 60_000 },
      );
      await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
      await send(ARRIVED + 1_000, downloadBody(2, { installId: "install-2" }));

      // A read applies what it would miss.
      expect(await chart()).toEqual([
        ["2026-10-14T23:00:00.000Z", 1],
        ["2026-10-16T01:00:00.000Z", 1],
      ]);
      await engine.flush();
      expect(await chart()).toEqual([
        ["2026-10-14T23:00:00.000Z", 1],
        ["2026-10-16T01:00:00.000Z", 1],
      ]);
      expect(await lifetimeDownloads()).toBe(2);
      await engine.dispose();
    },
  );

  it("loses no download to pruning under rawDays 1", async () => {
    const { send, chart, outcomeRows } = await engineWith({
      retention: { rawDays: 1, dailyDays: 1 },
    });
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
    // A later write runs the retention pass, due an hour on.
    await send(
      ARRIVED + 2 * 3_600_000,
      downloadBody(2, { installId: "install-2" }),
    );
    expect(await chart()).toEqual([
      ["2026-10-16T01:00:00.000Z", 1],
      ["2026-10-16T03:00:00.000Z", 1],
    ]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_IN")).toEqual([]);
  });

  it("charts nothing below zero once the hour it happened expires", async () => {
    const { send, chart, outcomeRows } = await engineWith({
      retention: { rawDays: 2, dailyDays: 2 },
    });
    await send(ARRIVED, downloadBody(1, { ageMs: AGE }));
    expect(await chart()).toEqual([["2026-10-14T23:00:00.000Z", 1]]);

    // 2026-10-14T23:00Z's row ends 2026-10-16T23:00Z, the arrival hour's a day
    // and two hours later. A write between them prunes only the first.
    await send(
      utc("2026-10-17T00:30:00Z"),
      downloadBody(2, { installId: "install-2" }),
    );
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_IN")).toEqual([]);
    expect(await outcomeRows("UPDATE_DOWNLOADED_MOVED_OUT")).toEqual([
      ["2026-10-16T01:00:00.000Z", 1],
    ]);
    expect(
      await chart(utc("2026-10-16T00:00:00Z"), utc("2026-10-18T00:00:00Z")),
    ).toEqual([["2026-10-17T00:00:00.000Z", 1]]);
  });
});

describe("a report's age on the wire", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: ARRIVED });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const post = (body: Record<string, unknown>) =>
    parseBundleEventRequest(
      new Request("https://example.com/events", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["over 72 hours", HOUR_72 + 1],
    ["a fraction", 1.5],
    ["a string", "1000"],
    ["an object", {}],
  ])("records a report whose age is %s, without it", async (_label, ageMs) => {
    const parsed = await post(downloadBody(1, { ageMs }));
    expect(Object.hasOwn(parsed, "ageMs")).toBe(false);
    expect(createBundleEventRow(parsed).received_at_ms).toBe(ARRIVED);
  });

  it("keeps a body with no age byte-for-byte the row it was", async () => {
    const row = createBundleEventRow(await post(downloadBody(1)));
    expect(row.metadata).toEqual({
      cohort: "1",
      fingerprint_hash: null,
      sdk_version: "1.2.0",
      min_bundle_id: "builtin",
      update_strategy: "appVersion",
    });
  });

  it("stores no time for a report that stays in its arrival hour", async () => {
    const row = createBundleEventRow(
      await post(downloadBody(1, { ageMs: 60_000 })),
    );
    expect(Object.hasOwn(row.metadata, "occurred_at_ms")).toBe(false);
  });

  it("stores only the time it happened, and only on a download", async () => {
    const download = createBundleEventRow(
      await post(downloadBody(1, { ageMs: AGE })),
    );
    expect(download.received_at_ms).toBe(utc("2026-10-16T01:10:00Z"));
    expect(download.metadata).toEqual({
      cohort: "1",
      fingerprint_hash: null,
      sdk_version: "1.2.0",
      min_bundle_id: "builtin",
      update_strategy: "appVersion",
      occurred_at_ms: utc("2026-10-14T23:30:00Z"),
    });
    const applied = createBundleEventRow(
      await post(appliedBody(1, { ageMs: AGE })),
    );
    expect(Object.hasOwn(applied.metadata, "occurred_at_ms")).toBe(false);
  });
});
