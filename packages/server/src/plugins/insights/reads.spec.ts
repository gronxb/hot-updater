import type { BundleEventRow } from "@hot-updater/plugin-core";
import {
  addInsightsDistinct,
  countInsightsDistinct,
  createMemoryAdapter,
  type DatabaseAdapter,
  mergeInsightsDistinct,
} from "@hot-updater/plugin-core/internal";
import { createPluginTestHarness } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import * as engine from "../../database";
import { insights } from "./index";

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
      username: null,
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
  countInsightsDistinct(
    mergeInsightsDistinct(installs.map((id) => addInsightsDistinct(null, id))),
  );
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

describe("insights read budgets", () => {
  const setup = async () => {
    const meter = metered(createMemoryAdapter());
    const harness = await createPluginTestHarness(insights(), {
      engine,
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

  it("lists and finds events reading exactly the rows it returns", async () => {
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
    expect(listed.adapter.rows).toBe(5);
    expect(listed.tables).toEqual({ bundle_events: 5 });

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

  it("counts whole-hour windows from aggregates alone", async () => {
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

    const latest = await read(() =>
      api.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs: T0 + HOUR,
      }),
    );
    // installs 6–24, plus install-1, whose head moved to day 2
    expect(latest.result).toBe(20);
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

  it("reads release activity and app usage from counters, sketches, and gauges only", async () => {
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
      launches: 25,
      failedLaunches: 0,
    });
    expect(Object.keys(lifetime.tables)).toEqual(["insights_overview"]);

    const scope = await read(() =>
      api.getReleaseActivity({
        scope: { platform: "ios", channel: "production" },
        timeRange: { start: T0, end: T0 + 3 * DAY },
      }),
    );
    expect(scope.result.data[0]!.metrics).toMatchObject({
      launches: 25,
      uniqueUsers: distinct(installs),
      series: [
        { startMs: T0, launches: 24, failedLaunches: 0 },
        { startMs: T0 + 2 * DAY, launches: 1, failedLaunches: 0 },
      ],
    });
    expect(Object.keys(scope.tables).toSorted()).toEqual([
      "insights_overview",
      "insights_sketches",
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
      "insights_sketches",
    ]);
  });
});
