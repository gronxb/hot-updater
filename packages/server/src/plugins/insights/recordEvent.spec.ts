import { DatabaseSync } from "node:sqlite";

import type { BundleEventRow } from "@hot-updater/plugin-core";
import {
  countInsightsDistinct,
  createMemoryAdapter,
  type DatabaseAdapter,
  type WriteOp,
} from "@hot-updater/plugin-core/internal";
import { createPluginTestHarness } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import * as engine from "../../database";
import type { HotUpdaterDatabase } from "../../database/database";
import { createKvAdapter } from "../../database/kv/kvAdapter";
import { createMemoryKeyValueStore } from "../../database/kv/kvTestStore";
import { createSqlAdapter } from "../../database/sql/sqlAdapter";
import { sqliteExecutor } from "../../database/sql/sqlTestExecutors";
import {
  insights,
  insightsIdentity,
  type InsightsIdentityParts,
  type InsightsSchema,
} from "./index";
import { bundlePairKey, COUNTED_BY_DAY, PAIR_FIELD } from "./recordEvent";
import { DAILY_EVENTS } from "./schema";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = Date.UTC(2026, 8, 23, 10, 15);
const hour = (ms: number) => ms - (ms % HOUR);
const day = (ms: number) => ms - (ms % DAY);

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const event = (
  n: number,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    id: uuid(n),
    type: "UPDATE_APPLIED",
    install_id: "install-1",
    user_id: "user-1",
    from_release_id: "release-1",
    from_bundle_id: "bundle-1",
    to_release_id: "release-2",
    to_bundle_id: "bundle-2",
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
    received_at_ms: T,
    ...overrides,
  }) as BundleEventRow;

const unchanged = (
  n: number,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  event(n, {
    type: "UNCHANGED",
    from_release_id: null,
    from_bundle_id: null,
    metadata: { ...event(n).metadata, update_strategy: null },
    ...overrides,
  } as Partial<BundleEventRow>);

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

const identity = (
  parts: Partial<InsightsIdentityParts> &
    Pick<InsightsIdentityParts, "periodKind">,
) =>
  insightsIdentity({
    scopeKind: "channel",
    releaseKind: "all",
    releaseId: "",
    channel: "production",
    platform: "ios",
    appVersionKind: "all",
    appVersion: "",
    ...parts,
  });

describe.each(backends)("insights recordEvent on %s", (_name, adapter) => {
  const setup = async (wrap = (inner: DatabaseAdapter) => inner) => {
    const harness = await createPluginTestHarness(insights(), {
      engine,
      adapter: wrap(adapter()),
    });
    const db = harness.db as HotUpdaterDatabase<InsightsSchema>;
    const at = (key: string, bucket: number) => ({
      index: "window" as const,
      where: { identity: key },
      range: { gte: bucket, lte: bucket },
      limit: 100,
    });
    /** Each period's rows live in an aggregate of their own, with its retention. */
    const counters = {
      hour: "insights_overview",
      day: "insights_overview_daily",
      lifetime: "insights_overview_lifetime",
    } as const;
    const sketches = {
      hour: "insights_sketches",
      day: "insights_sketches_daily",
    } as const;
    const overview = async (
      key: string,
      bucket: number,
      period: keyof typeof counters = "hour",
    ) => (await db.findAggregates(counters[period], at(key, bucket))).rows[0];
    const sketch = async (
      key: string,
      bucket: number,
      period: keyof typeof sketches = "hour",
    ) => (await db.findAggregates(sketches[period], at(key, bucket))).rows[0];
    const distribution = async () =>
      (
        await db.findAggregates("insights_distribution", {
          index: "byScope",
          where: { channel: "production", platform: "ios" },
          limit: 100,
        })
      ).rows;
    const byBundle = async (
      field: "from_bundle_id" | "to_bundle_id",
      bundleId: string,
      type: string,
    ) =>
      (
        await db.findAggregates("insights_latest_by_bundle", {
          index: "byBundle",
          where: {
            platform: "ios",
            channel: "production",
            bundle_field: field,
            bundle_id: bundleId,
            type,
          },
          limit: 100,
        })
      ).rows;
    const outcomes = async (type: string, ref: string) =>
      (
        await db.findAggregates("insights_outcomes", {
          index: "byRef",
          where: {
            platform: "ios",
            channel: "production",
            type,
            bundle_ref: ref,
          },
          limit: 100,
        })
      ).rows;
    /** The per-day count of every event, which the global event list reads. */
    const everyEvent = async () =>
      (
        await db.findAggregates("insights_outcomes", {
          index: "byRef",
          where: DAILY_EVENTS,
          limit: 100,
        })
      ).rows;
    return {
      ...harness,
      db,
      overview,
      sketch,
      distribution,
      byBundle,
      outcomes,
      everyEvent,
    };
  };

  it("records the event with derived keys, the head, gauges, counters, and sketches", async () => {
    const {
      api,
      db,
      overview,
      sketch,
      distribution,
      byBundle,
      outcomes,
      everyEvent,
    } = await setup();
    await api.recordEvent(event(1));

    await expect(
      db.findOne("bundle_events", { id: uuid(1) }),
    ).resolves.toMatchObject({
      day: T - (T % DAY),
      movement_install_id: "install-1",
      bundle_ref: ["to:bundle-2"],
    });
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toEqual({ ...event(1), current_release_id: COUNTED_BY_DAY });
    // Gauges count the head in the UTC day of its event.
    await expect(distribution()).resolves.toEqual([
      {
        channel: "production",
        platform: "ios",
        app_version: "1.0.0",
        release_id: "release-2",
        bucket_start_ms: day(T),
        latest_installations: 1,
      },
    ]);
    for (const [field, bundle] of [
      ["from_bundle_id", "bundle-1"],
      ["to_bundle_id", "bundle-2"],
    ] as const) {
      await expect(
        byBundle(field, bundle, "UPDATE_APPLIED"),
      ).resolves.toMatchObject([{ installations: 1 }]);
    }
    await expect(
      outcomes("UPDATE_APPLIED", "to:bundle-2"),
    ).resolves.toMatchObject([{ bucket_start_ms: hour(T), events: 1 }]);
    // Every event's row is a UTC day's, not an hour's.
    await expect(everyEvent()).resolves.toEqual([
      { ...DAILY_EVENTS, bucket_start_ms: T - (T % DAY), events: 1 },
    ]);

    const release = { scopeKind: "release", releaseKind: "specific" } as const;
    const counters = { downloads: 0, launches: 1, failed_launches: 0 };
    await expect(
      overview(
        identity({
          ...release,
          releaseId: "release-2",
          periodKind: "lifetime",
        }),
        0,
        "lifetime",
      ),
    ).resolves.toMatchObject(counters);
    const releaseHour = await sketch(
      identity({ ...release, releaseId: "release-2", periodKind: "hour" }),
      hour(T),
    );
    expect(countInsightsDistinct(releaseHour!.launch_users)).toBe(1);
    for (const [periodKind, bucket] of [
      ["hour", hour(T)],
      ["day", T - (T % DAY)],
    ] as const) {
      await expect(
        overview(identity({ periodKind }), bucket, periodKind),
      ).resolves.toMatchObject(counters);
      // A channel's active installations come from its usage rows.
      await expect(
        sketch(identity({ periodKind }), bucket, periodKind),
      ).resolves.toBeUndefined();
      for (const appVersionKind of ["specific", "all"] as const) {
        const usage = await sketch(
          identity({
            scopeKind: "usage",
            appVersionKind,
            appVersion: appVersionKind === "specific" ? "1.0.0" : "",
            periodKind,
          }),
          bucket,
          periodKind,
        );
        expect(countInsightsDistinct(usage!.activity_users)).toBe(1);
        // Every platform's usage merges the platforms' rows on read.
        await expect(
          sketch(
            identity({
              scopeKind: "usage",
              platform: "all",
              appVersionKind,
              appVersion: appVersionKind === "specific" ? "1.0.0" : "",
              periodKind,
            }),
            bucket,
            periodKind,
          ),
        ).resolves.toBeUndefined();
      }
    }
  });

  it("keys an event by the one bundle its bundle filter reads", async () => {
    const { api, db } = await setup();
    await api.recordEvent(event(1));
    await api.recordEvent(
      event(2, { type: "RECOVERED", install_id: "install-2" }),
    );

    await expect(
      db.findOne("bundle_events", { id: uuid(2) }),
    ).resolves.toMatchObject({ bundle_ref: ["from:bundle-1"] });
    const scope = { platform: "ios", channel: "production" } as const;
    for (const [n, filter] of [
      [1, { ...scope, type: "UPDATE_APPLIED", toBundleId: "bundle-2" }],
      [2, { ...scope, type: "RECOVERED", fromBundleId: "bundle-1" }],
    ] as const) {
      await expect(
        api.listEvents({
          filter: { kind: "bundle", ...filter },
          sinceMs: T,
          beforeReceivedAtMs: T + HOUR,
          limit: 10,
        }),
      ).resolves.toMatchObject([{ id: uuid(n) }]);
    }
  });

  it("changes nothing for a repeated id, even with another payload", async () => {
    const { api, db, outcomes, everyEvent } = await setup();
    await api.recordEvent(event(1));
    await api.recordEvent(
      event(1, { install_id: "install-2", received_at_ms: T + HOUR }),
    );

    await expect(
      db.findOne("bundle_events", { id: uuid(1) }),
    ).resolves.toMatchObject({ install_id: "install-1" });
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-2" }),
    ).resolves.toBeNull();
    await expect(
      outcomes("UPDATE_APPLIED", "to:bundle-2"),
    ).resolves.toMatchObject([{ events: 1 }]);
    await expect(everyEvent()).resolves.toMatchObject([{ events: 1 }]);
  });

  it("moves the head only for a newer event and deletes gauge rows that reach zero", async () => {
    const { api, db, distribution, byBundle, outcomes } = await setup();
    await api.recordEvent(event(1));
    await api.recordEvent(
      event(2, {
        type: "UPDATE_DOWNLOADED",
        user_id: null,
        from_release_id: "release-2",
        from_bundle_id: "bundle-2",
        to_release_id: "release-3",
        to_bundle_id: "bundle-3",
        received_at_ms: T + 2 * HOUR,
      }),
    );
    await api.recordEvent(event(3, { received_at_ms: T + HOUR }));

    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({
      id: uuid(2),
      user_id: null,
      type: "UPDATE_DOWNLOADED",
      current_release_id: COUNTED_BY_DAY,
    });
    // A download leaves the installation on release-2, in the same UTC day.
    await expect(distribution()).resolves.toMatchObject([
      {
        release_id: "release-2",
        bucket_start_ms: day(T),
        latest_installations: 1,
      },
    ]);
    await expect(
      byBundle("to_bundle_id", "bundle-2", "UPDATE_APPLIED"),
    ).resolves.toEqual([]);
    await expect(
      byBundle("to_bundle_id", "bundle-3", "UPDATE_DOWNLOADED"),
    ).resolves.toMatchObject([{ installations: 1 }]);
    await expect(
      outcomes("UPDATE_APPLIED", "to:bundle-2"),
    ).resolves.toMatchObject([
      { bucket_start_ms: hour(T), events: 1 },
      { bucket_start_ms: hour(T + HOUR), events: 1 },
    ]);

    await api.recordEvent(event(4, { received_at_ms: T + 2 * HOUR }));
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({ id: uuid(4), type: "UPDATE_APPLIED" });
    await expect(distribution()).resolves.toMatchObject([
      {
        release_id: "release-2",
        bucket_start_ms: day(T),
        latest_installations: 1,
      },
    ]);

    // The next UTC day's event takes the head out of this day's rows.
    await api.recordEvent(event(5, { received_at_ms: T + DAY }));
    await expect(distribution()).resolves.toMatchObject([
      {
        release_id: "release-2",
        bucket_start_ms: day(T + DAY),
        latest_installations: 1,
      },
    ]);
  });

  it("records an UNCHANGED report as a launch that no event or outcome row keeps", async () => {
    const { api, db, overview, outcomes, everyEvent, byBundle } = await setup();
    await api.recordEvent(unchanged(1));

    await expect(db.findOne("bundle_events", { id: uuid(1) })).resolves.toBe(
      null,
    );
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toEqual({ ...unchanged(1), current_release_id: COUNTED_BY_DAY });
    await expect(outcomes("UNCHANGED", "to:bundle-2")).resolves.toEqual([]);
    await expect(everyEvent()).resolves.toEqual([]);
    await expect(
      overview(identity({ periodKind: "day" }), day(T), "day"),
    ).resolves.toMatchObject({ launches: 1 });
    await expect(
      byBundle("to_bundle_id", "bundle-2", "UNCHANGED"),
    ).resolves.toMatchObject([{ bucket_start_ms: day(T), installations: 1 }]);
    await expect(
      api.listEvents({
        filter: { kind: "all" },
        sinceMs: day(T),
        beforeReceivedAtMs: day(T) + DAY,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("writes nothing for an UNCHANGED report that repeats its head the same UTC day", async () => {
    const calls: string[] = [];
    const { api, db, overview } = await setup((inner) => ({
      ...inner,
      write: async (ops: readonly WriteOp[]) => {
        calls.push("write");
        return inner.write(ops);
      },
    }));
    await api.recordEvent(event(1));
    calls.length = 0;
    // Relaunches on the bundle the apply moved to, later that day.
    await api.recordEvent(unchanged(2, { received_at_ms: T + 5 * HOUR }));
    await api.recordEvent(unchanged(3, { received_at_ms: T + 6 * HOUR }));
    expect(calls).toEqual([]);
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({ id: uuid(1), type: "UPDATE_APPLIED" });
    await expect(
      overview(identity({ periodKind: "day" }), day(T), "day"),
    ).resolves.toMatchObject({ launches: 1 });

    // An UNCHANGED report keeps no event row, so a retry that lands the next
    // UTC day is known by the head's id.
    await api.recordEvent(unchanged(4, { received_at_ms: T + DAY }));
    calls.length = 0;
    await api.recordEvent(unchanged(4, { received_at_ms: T + 2 * DAY }));
    expect(calls).toEqual([]);
    await expect(
      overview(identity({ periodKind: "day" }), day(T + 2 * DAY), "day"),
    ).resolves.toBeUndefined();
  });

  it("records an UNCHANGED report again for a new UTC day, bundle, user, or a download's head", async () => {
    const { api, db, overview } = await setup();
    const head = () =>
      db.findOne("bundle_event_heads", { install_id: "install-1" });
    const launches = async (bucket: number) =>
      (await overview(identity({ periodKind: "day" }), bucket, "day"))
        ?.launches;

    await api.recordEvent(unchanged(1));
    await api.recordEvent(unchanged(2, { user_id: "user-2" }));
    await expect(head()).resolves.toMatchObject({ id: uuid(2) });
    await api.recordEvent(
      unchanged(3, { to_bundle_id: "bundle-3", to_release_id: "release-3" }),
    );
    await expect(head()).resolves.toMatchObject({ id: uuid(3) });
    await expect(launches(day(T))).resolves.toBe(3);

    // A download's head still runs the bundle it came from.
    await api.recordEvent(
      event(4, {
        type: "UPDATE_DOWNLOADED",
        from_release_id: "release-3",
        from_bundle_id: "bundle-3",
        to_release_id: "release-4",
        to_bundle_id: "bundle-4",
        received_at_ms: T + HOUR,
      }),
    );
    await api.recordEvent(
      unchanged(5, {
        to_bundle_id: "bundle-4",
        to_release_id: "release-4",
        received_at_ms: T + 2 * HOUR,
      }),
    );
    await expect(head()).resolves.toMatchObject({ id: uuid(5) });

    await api.recordEvent(
      unchanged(6, {
        to_bundle_id: "bundle-4",
        to_release_id: "release-4",
        received_at_ms: T + DAY,
      }),
    );
    await expect(head()).resolves.toMatchObject({ id: uuid(6) });
    await expect(launches(day(T + DAY))).resolves.toBe(1);
  });

  it("takes a head recorded while gauges counted hours out of its hour rows", async () => {
    const { api, db, distribution, byBundle } = await setup();
    // As an earlier release recorded it: the head names its current release,
    // and its gauges count it in the hour of its event.
    await db.transaction(async (tx) => {
      tx.create("bundle_event_heads", {
        ...event(1),
        current_release_id: "release-2",
      });
      const shardBy = "install-1";
      tx.aggregate(
        "insights_distribution",
        {
          channel: "production",
          platform: "ios",
          app_version: "1.0.0",
          release_id: "release-2",
          bucket_start_ms: hour(T),
        },
        { latest_installations: 1 },
        { shardBy },
      );
      for (const [field, bundleId] of [
        ["from_bundle_id", "bundle-1"],
        ["to_bundle_id", "bundle-2"],
        [PAIR_FIELD, bundlePairKey("bundle-1", "bundle-2")],
      ] as const) {
        tx.aggregate(
          "insights_latest_by_bundle",
          {
            platform: "ios",
            channel: "production",
            bundle_field: field,
            bundle_id: bundleId,
            type: "UPDATE_APPLIED",
            bucket_start_ms: hour(T),
          },
          { installations: 1 },
          { shardBy },
        );
      }
    });

    await api.recordEvent(unchanged(2, { received_at_ms: T + DAY }));

    await expect(distribution()).resolves.toEqual([
      {
        channel: "production",
        platform: "ios",
        app_version: "1.0.0",
        release_id: "release-2",
        bucket_start_ms: day(T + DAY),
        latest_installations: 1,
      },
    ]);
    await expect(
      byBundle("to_bundle_id", "bundle-2", "UPDATE_APPLIED"),
    ).resolves.toEqual([]);
    await expect(
      byBundle("to_bundle_id", "bundle-2", "UNCHANGED"),
    ).resolves.toMatchObject([
      { bucket_start_ms: day(T + DAY), installations: 1 },
    ]);
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({
      id: uuid(2),
      current_release_id: COUNTED_BY_DAY,
    });
  });

  it("reads the event and head in one round, gauge and sketch rows in a second, and writes once", async () => {
    const calls: string[] = [];
    const { api, measureReads } = await setup((inner) => ({
      ...inner,
      get: async (table, keys) => {
        calls.push(`get ${table.name}`);
        return inner.get(table, keys);
      },
      write: async (ops: readonly WriteOp[]) => {
        calls.push("write");
        return inner.write(ops);
      },
    }));
    const measured = await measureReads(() => api.recordEvent(event(1)));

    expect(measured.adapter.queries).toBe(0);
    expect(calls).toEqual([
      "get bundle_events",
      "get bundle_event_heads",
      "get insights_sketches",
      "get insights_sketches_daily",
      "get insights_distribution",
      "get insights_latest_by_bundle",
      "write",
    ]);
  });

  it("serializes events per installation and keeps gauges exact under concurrency", async () => {
    const { api, db, distribution } = await setup();
    const installs = ["a", "b", "c", "d"];
    const events = installs.flatMap((install, position) =>
      [0, 1, 2].map((step) =>
        event(position * 10 + step + 1, {
          install_id: `install-${install}`,
          received_at_ms: T + ((step * 7 + position) % 3) * HOUR,
        }),
      ),
    );
    await Promise.all(events.map((row) => api.recordEvent(row)));

    for (const install of installs) {
      const latest = events
        .filter((row) => row.install_id === `install-${install}`)
        .toSorted(
          (left, right) =>
            left.received_at_ms - right.received_at_ms ||
            (left.id < right.id ? -1 : 1),
        )
        .at(-1)!;
      await expect(
        db.findOne("bundle_event_heads", { install_id: `install-${install}` }),
      ).resolves.toMatchObject({ id: latest.id });
    }
    const counted = (await distribution()).reduce(
      (sum, row) => sum + row.latest_installations,
      0,
    );
    expect(counted).toBe(installs.length);
  });

  it("records a retried report once, and a racing installation's report under its id not at all", async () => {
    const { api, db, outcomes } = await setup();
    await api.recordEvent(event(1));
    // A retry repeats the report's id, even when it arrives an hour later.
    await api.recordEvent(event(1, { received_at_ms: T + HOUR }));
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({ id: uuid(1), received_at_ms: T });
    await expect(
      outcomes("UPDATE_APPLIED", "to:bundle-2"),
    ).resolves.toMatchObject([{ events: 1 }]);

    // The later writer reads the winner's row, at once or in the rerun after
    // its own insert fails, and changes nothing.
    const installs = ["install-2", "install-3"];
    await Promise.all(
      installs.map((install) =>
        api.recordEvent(event(2, { install_id: install })),
      ),
    );
    const stored = await db.findOne("bundle_events", { id: uuid(2) });
    const loser = installs.find((install) => install !== stored?.install_id);
    expect(installs).toContain(stored?.install_id);
    await expect(
      db.findOne("bundle_event_heads", { install_id: loser! }),
    ).resolves.toBeNull();
  });
});
