import {
  createMemoryAdapter,
  type DatabaseAdapter,
  addDistinct,
  countDistinct,
  mergeDistinct,
} from "@hot-updater/plugin-core";
import { createPluginTestHarness } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { InsightsBadRequestError } from "./errors";
import {
  createInsightsModel,
  insights,
  type BundleEventRow,
  createInsightsProvider,
  type InsightsEventPageInput,
} from "./index";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 20);

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const event = (
  n: number,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    id: uuid(n),
    type: "UPDATE_APPLIED",
    install_id: `install-${n}`,
    user_id: "user-1",
    from_release_id: "release-a",
    from_bundle_id: "bundle-a",
    to_release_id: "release-b",
    to_bundle_id: "bundle-b",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    metadata: {
      cohort: "1",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: null,
    },
    received_at_ms: T0 + n * 10 * 60_000,
    ...overrides,
  }) as BundleEventRow;

/** The HLL estimate for these installs, as the stored sketches merge to. */
const distinct = (installs: readonly string[]) =>
  countDistinct(mergeDistinct(installs.map((id) => addDistinct(null, id))));
const installs = Array.from({ length: 24 }, (_, n) => `install-${n + 1}`);

/** Rows each table returned, and the point reads it served. */
const metered = (inner: DatabaseAdapter) => {
  const rows = new Map<string, number>();
  const add = (table: string, count: number) =>
    rows.set(table, (rows.get(table) ?? 0) + count);
  const adapter: DatabaseAdapter = {
    ...inner,
    get: async (table, keys) => {
      const found = await inner.get(table, keys);
      add(table.name, found.filter((row) => row !== null).length);
      return found;
    },
    query: async (table, request) => {
      const found = await inner.query(table, request);
      add(table.name, found.length);
      return found;
    },
  };
  return { adapter, rows };
};

describe("insights latest events by bundle", () => {
  const setup = () =>
    createPluginTestHarness(insights(), { now: () => T0 + DAY });
  const halfPast = T0 + 30 * 60_000;

  it("counts each latest event once for the overview's predicates, even from a bundle to itself", async () => {
    const harness = await setup();
    for (const [n, moved] of [
      [31, { type: "UPDATE_APPLIED", from_bundle_id: "X", to_bundle_id: "X" }],
      [
        32,
        { type: "UPDATE_DOWNLOADED", from_bundle_id: "X", to_bundle_id: "X" },
      ],
      [33, { type: "RECOVERED", from_bundle_id: "X", to_bundle_id: "X" }],
      [
        34,
        { type: "UPDATE_DOWNLOADED", from_bundle_id: "X", to_bundle_id: "Y" },
      ],
    ] as const) {
      await harness.api.recordEvent(
        event(n, { ...moved, received_at_ms: halfPast }),
      );
    }
    const bundle = [
      { field: "from_bundle_id", value: "X", types: ["UPDATE_DOWNLOADED"] },
      {
        field: "to_bundle_id",
        value: "X",
        types: ["UNCHANGED", "UPDATE_APPLIED", "RECOVERED"],
      },
    ] as const;
    await expect(
      harness.api.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs: T0,
        bundle,
      }),
    ).resolves.toBe(4);
  });

  it("counts a head once when a from and a to predicate of one type both match it", async () => {
    const harness = await setup();
    for (const [n, moved] of [
      [21, { from_bundle_id: "A", to_bundle_id: "B" }],
      [22, { from_bundle_id: "A", to_bundle_id: "C" }],
      [23, { from_bundle_id: "D", to_bundle_id: "B" }],
      [24, { from_bundle_id: "B", to_bundle_id: "B" }],
    ] as const) {
      await harness.api.recordEvent(
        event(n, {
          ...moved,
          type: "UPDATE_DOWNLOADED",
          received_at_ms: halfPast,
        }),
      );
    }
    const types = ["UPDATE_DOWNLOADED"] as const;
    const count = (
      bundle: readonly {
        readonly field: "from_bundle_id" | "to_bundle_id";
        readonly value: string;
        readonly types: readonly "UPDATE_DOWNLOADED"[];
      }[],
      sinceMs: number,
    ) =>
      harness.api.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs,
        bundle,
      });
    // From A or to B: A→B, A→C, D→B, and B→B. The gauges alone say 5,
    // counting A→B under both predicates.
    await expect(
      count(
        [
          { field: "from_bundle_id", value: "A", types },
          { field: "to_bundle_id", value: "B", types },
        ],
        T0,
      ),
    ).resolves.toBe(4);
    // B→B matches from B and to B through one pair: A→B, D→B, B→B.
    await expect(
      count(
        [
          { field: "from_bundle_id", value: "B", types },
          { field: "to_bundle_id", value: "B", types },
        ],
        T0,
      ),
    ).resolves.toBe(3);
  });

  it("counts whole UTC days only, and rejects a start inside one", async () => {
    const harness = await setup();
    await harness.api.recordEvent(event(1, { received_at_ms: halfPast }));
    await harness.api.recordEvent(
      event(2, { received_at_ms: T0 + DAY + HOUR }),
    );
    const since = (sinceMs: number) =>
      harness.api.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs,
      });
    await expect(since(T0)).resolves.toBe(2);
    await expect(since(T0 + DAY)).resolves.toBe(1);
    await expect(since(T0 + 2 * DAY)).resolves.toBe(0);
    for (const sinceMs of [T0 + 1, T0 + HOUR]) {
      await expect(since(sinceMs)).rejects.toMatchObject({
        code: "invalid-query",
      });
    }
  });
});

describe("insights read budgets", () => {
  const setup = async () => {
    const meter = metered(createMemoryAdapter());
    const harness = await createPluginTestHarness(insights(), {
      adapter: meter.adapter,
      now: () => T0 + 30 * DAY,
    });
    for (let n = 1; n <= 24; n += 1) await harness.api.recordEvent(event(n));
    await harness.api.recordEvent(
      event(25, { install_id: "install-1", received_at_ms: T0 + 2 * DAY }),
    );
    meter.rows.clear();
    const read = async <T>(call: () => Promise<T>) => {
      meter.rows.clear();
      const measured = await harness.measureReads(call);
      return { ...measured, tables: Object.fromEntries(meter.rows) };
    };
    return { api: harness.api, read };
  };

  it("lists and finds events reading the rows they return, and one outcome row to cross an empty day", async () => {
    const { api, read } = await setup();
    const listed = await read(() =>
      api.listEvents({
        filter: {
          kind: "bundle",
          platform: "ios",
          channel: "production",
          type: "UPDATE_APPLIED",
          toBundleId: "bundle-b",
        },
        sinceMs: T0,
        beforeReceivedAtMs: T0 + 3 * DAY,
        limit: 5,
      }),
    );
    expect(listed.result.map(({ id }) => id)).toEqual(
      [25, 24, 23, 22, 21].map(uuid),
    );
    // Day 2 holds event 25 and day 1 nothing, so one outcome row, hour 4 of
    // day 0, names the day below it.
    expect(listed.adapter).toMatchObject({ queries: 4, rows: 6 });
    expect(listed.tables).toEqual({ bundle_events: 5, insights_outcomes: 1 });

    const head = await read(() =>
      api.findLatestEvents({ installId: "install-1" }),
    );
    expect(head.result.map(({ id }) => id)).toEqual([uuid(25)]);
    expect(head.adapter).toMatchObject({ gets: 1, queries: 0 });

    const user = await read(() =>
      api.findLatestEvents({ userId: "user-1", limit: 3 }),
    );
    expect(user.result.map(({ install_id }) => install_id)).toEqual([
      "install-1",
      "install-10",
      "install-11",
    ]);
    expect(user.tables).toEqual({ bundle_event_heads: 3 });
  });

  it("counts whole hours and whole UTC days from aggregates alone", async () => {
    const { api, read } = await setup();
    const counted = await read(() =>
      api.countEvents({
        filter: {
          platform: "ios",
          channel: "production",
          type: "UPDATE_APPLIED",
          toBundleId: "bundle-b",
        },
        sinceMs: T0,
        beforeReceivedAtMs: T0 + 2 * HOUR,
      }),
    );
    expect(counted.result).toBe(11);
    expect(Object.keys(counted.tables)).toEqual(["insights_outcomes"]);

    // The same hourly counts in intervals, every interval present.
    const series = await read(() =>
      api.countEventSeries({
        filter: {
          platform: "ios",
          channel: "production",
          type: "UPDATE_APPLIED",
          toBundleId: "bundle-b",
        },
        timeRange: { start: T0, end: T0 + 3 * DAY },
        intervalMs: DAY,
      }),
    );
    expect(series.result).toEqual([
      { startMs: T0, events: 24 },
      { startMs: T0 + DAY, events: 0 },
      { startMs: T0 + 2 * DAY, events: 1 },
    ]);
    expect(Object.keys(series.tables)).toEqual(["insights_outcomes"]);

    const latest = await read(() =>
      api.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs: T0 + DAY,
      }),
    );
    // install-1, whose head moved to day 2
    expect(latest.result).toBe(1);
    expect(Object.keys(latest.tables)).toEqual(["insights_distribution"]);

    const byBundle = await read(() =>
      api.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs: T0,
        bundle: [
          {
            field: "to_bundle_id",
            value: "bundle-b",
            types: ["UPDATE_APPLIED"],
          },
        ],
      }),
    );
    expect(byBundle.result).toBe(24);
    expect(Object.keys(byBundle.tables)).toEqual(["insights_latest_by_bundle"]);
  });

  it("reads release activity from lifetime counters, and app usage from sketches and gauges only", async () => {
    const { api, read } = await setup();
    const lifetime = await read(() =>
      api.getReleaseActivity({
        releases: [
          { releaseId: "release-b", platform: "ios", channel: "production" },
        ],
      }),
    );
    expect(lifetime.result.data[0]!.metrics).toEqual({
      downloads: 0,
      // Every apply report, install-1's second one too.
      applies: 25,
      failedLaunches: 0,
    });
    expect(Object.keys(lifetime.tables)).toEqual([
      "insights_overview_lifetime",
    ]);

    const usage = await read(() =>
      api.getAppUsage({
        channel: "production",
        platform: "all",
        timeRange: { start: T0, end: T0 + 3 * DAY },
        intervalMs: DAY,
      }),
    );
    expect(usage.result).toMatchObject({
      activeInstallations: distinct(installs),
      points: [
        { startMs: T0, installations: distinct(installs) },
        { startMs: T0 + DAY, installations: 0 },
        { startMs: T0 + 2 * DAY, installations: 1 },
      ],
      versions: [{ name: "1.0.0", installations: 24 }],
      bundleDistribution: [
        {
          appVersion: "1.0.0",
          platform: "ios",
          releaseId: "release-b",
          installations: 24,
        },
      ],
    });
    expect(Object.keys(usage.tables).toSorted()).toEqual([
      "insights_distribution",
      "insights_sketches_daily",
    ]);
  });
});

describe("insights update failures", () => {
  const setup = async () => {
    const meter = metered(createMemoryAdapter());
    const harness = await createPluginTestHarness(insights(), {
      adapter: meter.adapter,
      now: () => T0 + 30 * DAY,
    });
    const record = (
      n: number,
      install: number,
      at: number,
      overrides: Partial<BundleEventRow>,
      metadata: Record<string, unknown> = {},
    ) =>
      harness.api.recordEvent(
        event(n, {
          install_id: `install-${install}`,
          received_at_ms: at,
          ...overrides,
          metadata: { ...event(n).metadata, ...metadata },
        } as Partial<BundleEventRow>),
      );
    const fail = (
      n: number,
      install: number,
      at: number,
      failure: Record<string, unknown>,
    ) =>
      record(
        n,
        install,
        at,
        failure.stage === "check"
          ? {
              type: "UPDATE_FAILED",
              to_release_id: null,
              to_bundle_id: "bundle-a",
            }
          : { type: "UPDATE_FAILED" },
        { failure },
      );
    const denied = { stage: "download", reason: "http", http_status: 403 };
    // install-1 fails to download release-b on two days, install-2 once with
    // another origin code, install-3 on the network, install-4 installing.
    await fail(1, 1, T0 + HOUR, { ...denied, origin_code: "AccessDenied" });
    await fail(2, 1, T0 + DAY + HOUR, {
      ...denied,
      origin_code: "AccessDenied",
    });
    await fail(3, 2, T0 + 2 * HOUR, { ...denied, origin_code: "ExpiredToken" });
    await fail(4, 3, T0 + 3 * HOUR, {
      stage: "download",
      reason: "network",
      transport: "timeout",
    });
    await fail(5, 4, T0 + 4 * HOUR, {
      stage: "install",
      reason: "hash_mismatch",
    });
    // install-8's update check fails: its channel's, no release's.
    await fail(6, 8, T0 + 5 * HOUR, { stage: "check", reason: "http" });
    // Three downloads: two by patch, one that fell back from a patch.
    for (const [n, install, metadata] of [
      [7, 5, { delivery: "patch" }],
      [8, 6, { delivery: "patch" }],
      [9, 7, { delivery: "archive", patch_fallback: true }],
    ] as const) {
      await record(
        n,
        install,
        T0 + 6 * HOUR,
        { type: "UPDATE_DOWNLOADED" },
        metadata,
      );
    }
    // Two recoveries from release-b.
    const recovered = {
      type: "RECOVERED",
      from_release_id: "release-b",
      from_bundle_id: "bundle-b",
      to_release_id: "release-a",
      to_bundle_id: "bundle-a",
    } as const;
    await record(10, 9, T0 + 7 * HOUR, recovered);
    await record(11, 10, T0 + 7 * HOUR, recovered);
    const read = async <T>(call: () => Promise<T>) => {
      meter.rows.clear();
      const measured = await harness.measureReads(call);
      return {
        ...measured,
        tables: Object.keys(Object.fromEntries(meter.rows)),
      };
    };
    return { api: harness.api, db: harness.db, read };
  };
  const scope = { platform: "ios", channel: "production" } as const;

  it("reads a release's failures, installations, and breakdown over a window from aggregates only", async () => {
    const { api, read } = await setup();
    const failures = await read(() =>
      api.getUpdateFailures({
        ...scope,
        releaseId: "release-b",
        timeRange: { start: T0, end: T0 + 2 * DAY },
      }),
    );
    expect(failures.result).toEqual({
      coverage: { kind: "complete", sinceMs: 0 },
      measuredAtMs: T0 + 30 * DAY,
      failedUpdates: 5,
      failedInstallations: distinct([
        "install-1",
        "install-2",
        "install-3",
        "install-4",
      ]),
      downloads: 3,
      patchDownloads: 2,
      patchFallbacks: 1,
      breakdown: [
        {
          stage: "download",
          reason: "http",
          events: 3,
          details: [
            {
              resource: null,
              httpStatus: 403,
              originCode: "AccessDenied",
              transport: null,
              events: 2,
            },
            {
              resource: null,
              httpStatus: 403,
              originCode: "ExpiredToken",
              transport: null,
              events: 1,
            },
          ],
        },
        {
          stage: "download",
          reason: "network",
          events: 1,
          details: [
            {
              resource: null,
              httpStatus: null,
              originCode: null,
              transport: "timeout",
              events: 1,
            },
          ],
        },
        {
          stage: "install",
          reason: "hash_mismatch",
          events: 1,
          details: [
            {
              resource: null,
              httpStatus: null,
              originCode: null,
              transport: null,
              events: 1,
            },
          ],
        },
      ],
    });
    expect(failures.tables.toSorted()).toEqual([
      "insights_failures",
      "insights_overview",
      "insights_sketches",
    ]);
  });

  it("counts only the stages a failure records", async () => {
    const { api, db } = await setup();
    // A breakdown row of another stage, as recoveries' exit reasons once were.
    await db.transaction(async (tx) => {
      tx.aggregate(
        "insights_failures",
        {
          ...scope,
          bucket_start_ms: T0 + 7 * HOUR,
          release_id: "release-b",
          stage: "launch",
          reason: "CRASH",
          detail: "",
        },
        { events: 1 },
        { shardBy: "install-9" },
      );
    });
    const failures = await api.getUpdateFailures({
      ...scope,
      releaseId: "release-b",
      timeRange: { start: T0, end: T0 + 2 * DAY },
    });
    expect(failures.failedUpdates).toBe(5);
    expect(failures.breakdown!.map(({ stage }) => stage)).toEqual([
      "download",
      "download",
      "install",
    ]);
  });

  it("reads a channel's failed checks against its active installations, from daily rows past 48 hours", async () => {
    const { api, read } = await setup();
    const failures = await read(() =>
      api.getUpdateFailures({
        ...scope,
        timeRange: { start: T0, end: T0 + 3 * DAY },
      }),
    );
    expect(failures.result).toMatchObject({
      failedUpdates: 5,
      failedInstallations: distinct([
        "install-1",
        "install-2",
        "install-3",
        "install-4",
      ]),
      downloads: 3,
      // A failure is no activity: the downloads' and recoveries' installations.
      checks: {
        failures: 1,
        failedInstallations: distinct(["install-8"]),
        activeInstallations: distinct([
          "install-5",
          "install-6",
          "install-7",
          "install-9",
          "install-10",
        ]),
      },
    });
    expect(
      failures.result.breakdown!.map(({ stage, reason, events }) => [
        stage,
        reason,
        events,
      ]),
    ).toEqual([
      ["download", "http", 3],
      ["check", "http", 1],
      ["download", "network", 1],
      ["install", "hash_mismatch", 1],
    ]);
    expect(failures.tables.toSorted()).toEqual([
      "insights_failures",
      "insights_overview_daily",
      "insights_sketches_daily",
    ]);
  });

  it("reads a release's failures since its first from the kept rows, and needs a range of at most 30 days for a channel", async () => {
    const { api, read } = await setup();
    const lifetime = await read(() =>
      api.getUpdateFailures({ ...scope, releaseId: "release-b" }),
    );
    expect(lifetime.result).toEqual({
      coverage: { kind: "complete", sinceMs: 0 },
      measuredAtMs: T0 + 30 * DAY,
      failedUpdates: 5,
      failedInstallations: distinct([
        "install-1",
        "install-2",
        "install-3",
        "install-4",
      ]),
      downloads: 3,
      patchDownloads: 2,
      patchFallbacks: 1,
    });
    expect(lifetime.tables.toSorted()).toEqual([
      "insights_overview_lifetime",
      "insights_sketches_lifetime",
    ]);
    for (const invalid of [
      scope,
      { ...scope, platform: "web" },
      { ...scope, releaseId: "release-b", timeRange: { start: 10, end: 10 } },
      // Longer than the console's longest period, 30 days.
      { ...scope, timeRange: { start: T0, end: T0 + 30 * DAY + 1 } },
    ]) {
      await expect(
        api.getUpdateFailures(invalid as never),
      ).rejects.toMatchObject({ code: "invalid-query" });
    }
  });
});

/**
 * The reads an event list makes, in order: each UTC day it reads, as days
 * from T0, with the rows it found; and each outcome read, with the day it
 * named.
 */
const traced = (inner: DatabaseAdapter) => {
  const reads: string[] = [];
  const day = (ms: number) => `day ${(ms - (ms % DAY) - T0) / DAY}`;
  const adapter: DatabaseAdapter = {
    ...inner,
    query: async (table, request) => {
      const found = await inner.query(table, request);
      if (table.name === "bundle_events") {
        reads.push(`${day(Number(request.eq.at(-1)))}: ${found.length}`);
      }
      if (table.name === "insights_outcomes") {
        const newest = found[0]?.bucket_start_ms;
        reads.push(
          `hint: ${newest === undefined ? "none" : day(Number(newest))}`,
        );
      }
      return found;
    },
  };
  return { adapter, reads };
};

const newestFirst = (left: BundleEventRow, right: BundleEventRow) =>
  right.received_at_ms - left.received_at_ms ||
  (right.id < left.id ? -1 : right.id > left.id ? 1 : 0);

describe("insights event list ranges", () => {
  /** The cutoff: noon of T0's day, so the range starts at noon 90 days before. */
  const before = T0 + 12 * HOUR;
  const bundleB = {
    kind: "bundle",
    platform: "ios",
    channel: "production",
    type: "UPDATE_APPLIED",
    toBundleId: "bundle-b",
  } as const;

  const setup = async () => {
    const trace = traced(createMemoryAdapter());
    const harness = await createPluginTestHarness(insights(), {
      adapter: trace.adapter,
      now: () => before,
    });
    const provider = createInsightsProvider(createInsightsModel(harness.api));
    const record = async (
      events: readonly (readonly [number, number, Partial<BundleEventRow>?])[],
    ) => {
      for (const [n, receivedAtMs, overrides] of events) {
        await harness.api.recordEvent(
          event(n, { ...overrides, received_at_ms: receivedAtMs }),
        );
      }
    };
    /** Every page of one provider list, with the reads each made. */
    const pages = async (input: InsightsEventPageInput) => {
      const listed: { ids: string[]; reads: string[]; full: boolean }[] = [];
      let cursor: string | undefined;
      do {
        trace.reads.length = 0;
        const page = await provider.listEvents({
          ...input,
          ...(cursor === undefined ? {} : { cursor }),
        });
        listed.push({
          ids: page.data.map(({ id }) => id),
          reads: [...trace.reads],
          full: page.data.length === input.limit,
        });
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return listed;
    };
    return { harness, provider, record, pages, reads: trace.reads };
  };

  it("rejects a global or bundle range over 90 days, not installation history", async () => {
    const { harness } = await setup();
    for (const filter of [{ kind: "all" } as const, bundleB]) {
      const input = { filter, beforeReceivedAtMs: before, limit: 5 };
      await expect(
        harness.api.listEvents({ ...input, sinceMs: before - 90 * DAY }),
      ).resolves.toEqual([]);
      for (const sinceMs of [before - 90 * DAY - 1, undefined]) {
        await expect(
          harness.api.listEvents({ ...input, sinceMs }),
        ).rejects.toMatchObject({ code: "invalid-query" });
      }
    }
    await expect(
      harness.api.listEvents({
        filter: { kind: "installationMovement", installId: "install-1" },
        beforeReceivedAtMs: before,
        limit: 5,
      }),
    ).resolves.toEqual([]);
  });

  it("takes exactly 90 × 24 hours ending mid-day, 91 UTC days, and pages them to the start", async () => {
    const { harness, provider, record, pages } = await setup();
    // As the console's "Last 90 days" asks: the cutoff is not a midnight, so
    // the range starts at noon of its 91st UTC day.
    const since = before - 90 * DAY;
    await record([
      [1, before - 1],
      [2, T0 - 45 * DAY],
      [3, since + 1],
      [4, since],
      [5, since - 1],
    ]);
    const listed = await pages({
      sinceMs: since,
      beforeReceivedAtMs: before,
      limit: 2,
    });
    expect(listed).toEqual([
      {
        ids: [1, 2].map(uuid),
        reads: ["day 0: 1", "day -1: 0", "hint: day -45", "day -45: 1"],
        full: true,
      },
      {
        ids: [3, 4].map(uuid),
        reads: ["day -45: 0", "hint: day -90", "day -90: 2"],
        full: true,
      },
      { ids: [], reads: ["day -90: 0"], full: false },
    ]);
    // One millisecond longer is refused by the plugin and by the provider.
    await expect(
      harness.api.listEvents({
        filter: { kind: "all" },
        sinceMs: since - 1,
        beforeReceivedAtMs: before,
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      provider.listEvents({ sinceMs: since - 1, beforeReceivedAtMs: before }),
    ).rejects.toBeInstanceOf(InsightsBadRequestError);
  });

  it("reads an empty range as its top day and one hint, and a dense day as one query", async () => {
    const { harness, record, reads } = await setup();
    // A day below the range, and past the cutoff on its top day.
    await record([
      [1, before - 91 * DAY],
      [2, before],
    ]);
    const list = (filter: typeof bundleB | { readonly kind: "all" }) =>
      harness.measureReads(() =>
        harness.api.listEvents({
          filter,
          sinceMs: before - 90 * DAY,
          beforeReceivedAtMs: before,
          limit: 4,
        }),
      );
    for (const filter of [{ kind: "all" } as const, bundleB]) {
      reads.length = 0;
      const empty = await list(filter);
      expect(empty.result).toEqual([]);
      expect(empty.adapter).toEqual({ gets: 0, keys: 0, queries: 2, rows: 0 });
      expect(reads).toEqual(["day 0: 0", "hint: none"]);
    }
    await record([3, 4, 5, 6, 7].map((n) => [n, T0 + n * HOUR] as const));
    for (const filter of [{ kind: "all" } as const, bundleB]) {
      reads.length = 0;
      const dense = await list(filter);
      expect(dense.result.map(({ id }) => id)).toEqual([7, 6, 5, 4].map(uuid));
      expect(dense.adapter).toEqual({ gets: 0, keys: 0, queries: 1, rows: 4 });
      expect(reads).toEqual(["day 0: 4"]);
    }
  });

  it("crosses gaps of months with one empty day and one hint each, and fills every page down to the range start", async () => {
    const { record, pages } = await setup();
    const since = before - 90 * DAY;
    await record([
      [1, T0 - 40 * DAY + 3 * HOUR],
      [2, T0 - 40 * DAY + 2 * HOUR],
      [3, T0 - 40 * DAY + HOUR],
      [4, T0 - 80 * DAY + 12 * HOUR],
      [5, T0 - 80 * DAY + 11 * HOUR],
      // The range's first day holds events on both sides of its start.
      [6, since + HOUR],
      [7, since - HOUR],
      // Below the range, and past the cutoff on its top day.
      [8, T0 - 100 * DAY],
      [9, before + HOUR],
    ]);
    // Without `sinceMs`, the range is the 90 days before the cutoff.
    const listed = await pages({ beforeReceivedAtMs: before, limit: 4 });
    expect(listed).toEqual([
      {
        ids: [1, 2, 3, 4].map(uuid),
        reads: [
          "day 0: 0",
          "hint: day -40",
          "day -40: 3",
          "day -41: 0",
          "hint: day -80",
          "day -80: 1",
        ],
        full: true,
      },
      {
        // The last page ends at the range's last event, with no cursor.
        ids: [5, 6].map(uuid),
        reads: ["day -80: 1", "day -81: 0", "hint: day -90", "day -90: 1"],
        full: false,
      },
    ]);
    // Only the day read before each hint is empty, however long the gap.
    for (const { reads } of listed) {
      reads.forEach((read, index) => {
        if (read.endsWith(": 0")) expect(reads[index + 1]).toMatch(/^hint/);
      });
    }
  });

  it("crosses a bundle's gaps on its own outcome rows, whatever other bundles hold", async () => {
    const { record, pages } = await setup();
    const bundleC = { to_bundle_id: "bundle-c" };
    await record([
      [1, T0 - DAY],
      [2, T0 - 2 * DAY, bundleC],
      [3, T0 - 3 * DAY, bundleC],
      [4, T0 - 30 * DAY, bundleC],
      [5, T0 - 50 * DAY + 2 * HOUR],
      [6, T0 - 50 * DAY + HOUR],
    ]);
    const listed = await pages({
      bundle: {
        platform: "ios",
        channel: "production",
        bundleId: "bundle-b",
        outcome: "applied",
      },
      beforeReceivedAtMs: before,
      limit: 5,
    });
    expect(listed).toEqual([
      {
        ids: [1, 5, 6].map(uuid),
        // Days -3 and -30 hold only bundle-c's events and are never read;
        // day -2 is the one empty day before a hint.
        reads: [
          "day 0: 0",
          "hint: day -1",
          "day -1: 1",
          "day -2: 0",
          "hint: day -50",
          "day -50: 2",
          "day -51: 0",
          "hint: none",
        ],
        full: false,
      },
    ]);
  });

  it("lists every event in the range, alone in a gap or recorded in one while paging", async () => {
    const { harness, provider, record } = await setup();
    await record(
      [0, -1, -17, -53, -54, -88, -89].map(
        (day, index) => [index + 1, T0 + day * DAY + HOUR] as const,
      ),
    );
    const listed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider.listEvents({
        beforeReceivedAtMs: before,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (cursor === undefined) {
        // Below the first page, in the gap between days -17 and -53.
        await harness.api.recordEvent(
          event(8, { received_at_ms: T0 - 30 * DAY }),
        );
      }
      listed.push(...page.data.map(({ id }) => id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(listed).toEqual([1, 2, 3, 8, 4, 5, 6, 7].map(uuid));
  });

  it("pages exactly the events in the range, newest first, whatever the limit", async () => {
    const { harness, pages } = await setup();
    const since = T0 - 80 * DAY + 5 * HOUR;
    let seed = 7;
    const random = () =>
      (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    const times = [
      since - 1,
      since,
      before - 1,
      before,
      T0 - 30 * DAY,
      T0 - 30 * DAY - 1,
      ...Array.from(
        { length: 54 },
        () => T0 - 100 * DAY + Math.floor(random() * 101 * DAY),
      ),
    ];
    const events = times.map((receivedAtMs, index) =>
      event(index + 1, {
        received_at_ms: receivedAtMs,
        ...(index % 3 === 0
          ? { type: "RECOVERED", from_bundle_id: "bundle-b" }
          : { to_bundle_id: index % 3 === 1 ? "bundle-b" : "bundle-c" }),
      }),
    );
    for (const row of events) await harness.api.recordEvent(row);
    const selections = [
      [undefined, () => true],
      [
        "applied",
        (row: BundleEventRow) =>
          row.type === "UPDATE_APPLIED" && row.to_bundle_id === "bundle-b",
      ],
      [
        "recovered",
        (row: BundleEventRow) =>
          row.type === "RECOVERED" && row.from_bundle_id === "bundle-b",
      ],
    ] as const;
    for (const [outcome, matches] of selections) {
      const expected = events
        .filter(
          (row) =>
            matches(row) &&
            row.received_at_ms >= since &&
            row.received_at_ms < before,
        )
        .toSorted(newestFirst)
        .map(({ id }) => id);
      for (const limit of [1, 3, 8]) {
        const listed = await pages({
          ...(outcome === undefined
            ? {}
            : {
                bundle: {
                  platform: "ios",
                  channel: "production",
                  bundleId: "bundle-b",
                  outcome,
                },
              }),
          sinceMs: since,
          beforeReceivedAtMs: before,
          limit,
        });
        expect(listed.flatMap(({ ids }) => ids)).toEqual(expected);
        // Every page but the last is full; the last is empty only after a
        // full page that ended at the range's last event.
        expect(listed.slice(0, -1).every(({ full }) => full)).toBe(true);
        expect(listed.at(-1)!.ids.length).toBe(expected.length % limit);
      }
    }
  });
});
