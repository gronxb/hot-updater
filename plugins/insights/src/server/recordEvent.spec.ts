import { DatabaseSync } from "node:sqlite";

import type { HotUpdaterDatabase } from "@hot-updater/plugin-core";
import {
  createKvAdapter,
  createSqlAdapter,
  createMemoryAdapter,
  type DatabaseAdapter,
  type WriteOp,
  countDistinct,
} from "@hot-updater/plugin-core";
import {
  createPluginTestHarness,
  createMemoryKeyValueStore,
} from "@hot-updater/test-utils";
import { sqliteExecutor } from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import { matchesInsightsEventFilter } from "./contract";
import {
  insights,
  insightsIdentity,
  type InsightsIdentityParts,
  type InsightsSchema,
  type BundleEventRow,
} from "./index";
import { bundleRefsOf, DAILY_EVENTS, isLaunch } from "./schema";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = Date.UTC(2026, 8, 23, 10, 15);
const hour = (ms: number) => ms - (ms % HOUR);
const day = (ms: number) => ms - (ms % DAY);

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A UUIDv7 report ID made, by the device's clock, at `ms`. */
const madeId = (ms: number, n: number) =>
  `${ms
    .toString(16)
    .padStart(12, "0")
    .replace(
      /^(.{8})(.{4})$/,
      "$1-$2",
    )}-7000-8000-${String(n).padStart(12, "0")}`;

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

/** An update failure from install-2, which runs bundle-2 and targets bundle-3. */
const failure = (
  n: number,
  failed: Record<string, unknown>,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  event(n, {
    type: "UPDATE_FAILED",
    install_id: "install-2",
    from_release_id: "release-2",
    from_bundle_id: "bundle-2",
    to_release_id: "release-3",
    to_bundle_id: "bundle-3",
    metadata: { ...event(n).metadata, failure: failed },
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
    /** A release's lifetime counters: downloads, launches, crashes. */
    const lifetime = async (releaseId: string) => {
      const row = (
        await db.findAggregates(
          "insights_overview_lifetime",
          at(
            identity({
              scopeKind: "release",
              releaseKind: "specific",
              releaseId,
              periodKind: "lifetime",
            }),
            0,
          ),
        )
      ).rows[0];
      return {
        downloads: row?.downloads ?? 0,
        launches: row?.applies ?? 0,
        crashes: row?.failed_launches ?? 0,
      };
    };
    /** A release's applies: only its lifetime row counts them. */
    const applies = async (releaseId: string) =>
      (await lifetime(releaseId)).launches;
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
    /** Update failures and recovery exits by what failed, which the breakdown reads. */
    const failures = async () =>
      (
        await db.findAggregates("insights_failures", {
          index: "byScope",
          where: { platform: "ios", channel: "production" },
          limit: 100,
        })
      ).rows;
    const failedUsers = async (
      key: string,
      bucket: number,
      period: "hour" | "day" | "lifetime" = "hour",
    ) =>
      countDistinct(
        (
          await db.findAggregates(
            period === "lifetime"
              ? "insights_sketches_lifetime"
              : sketches[period],
            at(key, bucket),
          )
        ).rows[0]?.failed_users,
      );
    return {
      ...harness,
      db,
      overview,
      sketch,
      applies,
      lifetime,
      distribution,
      byBundle,
      outcomes,
      everyEvent,
      failures,
      failedUsers,
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
    ).resolves.toEqual(event(1));
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

    const release = {
      scopeKind: "release",
      releaseKind: "specific",
      releaseId: "release-2",
    } as const;
    // An apply counts in its release's lifetime row alone: no hour, day, or
    // channel row counts it, and no release or channel row keeps a sketch.
    await expect(
      overview(identity({ ...release, periodKind: "lifetime" }), 0, "lifetime"),
    ).resolves.toMatchObject({ downloads: 0, applies: 1, failed_launches: 0 });
    const releaseHour = identity({ ...release, periodKind: "hour" });
    await expect(overview(releaseHour, hour(T))).resolves.toBeUndefined();
    await expect(sketch(releaseHour, hour(T))).resolves.toBeUndefined();
    for (const [periodKind, bucket] of [
      ["hour", hour(T)],
      ["day", T - (T % DAY)],
    ] as const) {
      await expect(
        overview(identity({ periodKind }), bucket, periodKind),
      ).resolves.toBeUndefined();
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
        expect(countDistinct(usage!.activity_users)).toBe(1);
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

  it("counts an installation on its native build's built-in bundle apart from an unknown one", async () => {
    const { api, db, distribution } = await setup();
    const builtin = uuid(900);
    /** A report from a native build that ships `builtin`. */
    const from = (row: BundleEventRow, minBundleId?: string) =>
      ({
        ...row,
        metadata: {
          ...row.metadata,
          ...(minBundleId === undefined ? {} : { min_bundle_id: minBundleId }),
        },
      }) as BundleEventRow;
    const launch = (n: number, install: string, bundle: string, at = T) =>
      unchanged(n, {
        install_id: install,
        to_release_id: null,
        to_bundle_id: bundle,
        received_at_ms: at,
      });
    /**
     * Installations by the release they run, and by that and the built-in
     * bundle for those that run it, summed over days.
     */
    const counts = async () => {
      const sums = new Map<string, number>();
      const add = (key: string, installations: number) =>
        sums.set(key, (sums.get(key) ?? 0) + installations);
      for (const row of await distribution()) {
        add(row.release_id, row.latest_installations);
      }
      const builtins = await db.findAggregates(
        "insights_builtin_distribution",
        {
          index: "byScope",
          where: { channel: "production", platform: "ios" },
          limit: 100,
        },
      );
      for (const row of builtins.rows) {
        add(
          `${row.release_id}|${row.builtin_bundle_id}`,
          row.latest_installations,
        );
      }
      return Object.fromEntries(
        [...sums].filter(([, installations]) => installations !== 0),
      );
    };

    // The built-in bundle, another bundle without a release, and an SDK
    // that does not say which bundle its build ships.
    await api.recordEvent(from(launch(1, "install-1", builtin), builtin));
    await api.recordEvent(from(launch(2, "install-2", "bundle-9"), builtin));
    await api.recordEvent(from(launch(3, "install-3", builtin)));
    await expect(counts()).resolves.toEqual({ "": 3, [`|${builtin}`]: 1 });

    // A download leaves the installation on the built-in bundle; the apply
    // moves it to the release.
    await api.recordEvent(
      from(
        event(4, {
          type: "UPDATE_DOWNLOADED",
          from_release_id: null,
          from_bundle_id: builtin,
          received_at_ms: T + HOUR,
        }),
        builtin,
      ),
    );
    await expect(counts()).resolves.toMatchObject({ [`|${builtin}`]: 1 });
    await api.recordEvent(
      from(
        event(5, {
          from_release_id: null,
          from_bundle_id: builtin,
          received_at_ms: T + 2 * HOUR,
        }),
        builtin,
      ),
    );
    // The head stored without the built-in bundle ID is taken back from the
    // row that counted it once the next day's report says it.
    await api.recordEvent(
      from(launch(6, "install-3", builtin, T + DAY), builtin),
    );
    await expect(counts()).resolves.toEqual({
      "release-2": 1,
      "": 2,
      [`|${builtin}`]: 1,
    });
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
    // An older apply of another bundle counts in its own hour but keeps the
    // newer head.
    await api.recordEvent(
      event(3, {
        to_release_id: "release-4",
        to_bundle_id: "bundle-4",
        received_at_ms: T + HOUR,
      }),
    );

    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({
      id: uuid(2),
      user_id: null,
      type: "UPDATE_DOWNLOADED",
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
    ).resolves.toMatchObject([{ bucket_start_ms: hour(T), events: 1 }]);
    await expect(
      outcomes("UPDATE_APPLIED", "to:bundle-4"),
    ).resolves.toMatchObject([{ bucket_start_ms: hour(T + HOUR), events: 1 }]);

    // The apply of the downloaded bundle ties the head's time and wins on id.
    await api.recordEvent(
      event(4, {
        from_release_id: "release-2",
        from_bundle_id: "bundle-2",
        to_release_id: "release-3",
        to_bundle_id: "bundle-3",
        received_at_ms: T + 2 * HOUR,
      }),
    );
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({ id: uuid(4), type: "UPDATE_APPLIED" });
    await expect(distribution()).resolves.toMatchObject([
      {
        release_id: "release-3",
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

  it("keeps an installation's first UNCHANGED report as first seen, which launches nothing", async () => {
    const { api, db, applies, outcomes, everyEvent, byBundle } = await setup();
    await api.recordEvent(unchanged(1));
    const firstSeen = {
      ...unchanged(1),
      metadata: {
        ...unchanged(1).metadata,
        change: { kinds: ["first_seen"], previous: null },
      },
    } as BundleEventRow;

    await expect(
      db.findOne("bundle_events", { id: uuid(1) }),
    ).resolves.toMatchObject({
      ...firstSeen,
      movement_install_id: "install-1",
      bundle_ref: [],
    });
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toEqual(firstSeen);
    // The installation is new to the server, not known to have launched
    // anything: no bundle list and no release counter count it.
    await expect(outcomes("UNCHANGED", "to:bundle-2")).resolves.toEqual([]);
    await expect(everyEvent()).resolves.toMatchObject([{ events: 1 }]);
    await expect(applies("release-2")).resolves.toBe(0);
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
    ).resolves.toEqual([firstSeen]);
  });

  it("writes nothing for an UNCHANGED report that repeats its head the same UTC day", async () => {
    const calls: string[] = [];
    const { api, db, applies } = await setup((inner) => ({
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
    await expect(applies("release-2")).resolves.toBe(1);

    // An UNCHANGED report that changes nothing keeps no event row, so a
    // retry that lands the next UTC day is known by the head's id.
    await api.recordEvent(unchanged(4, { received_at_ms: T + DAY }));
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({ id: uuid(4), type: "UNCHANGED" });
    calls.length = 0;
    await api.recordEvent(unchanged(4, { received_at_ms: T + 2 * DAY }));
    expect(calls).toEqual([]);
    // The apply counted once; launches since add nothing.
    await expect(applies("release-2")).resolves.toBe(1);
  });

  it("records an UNCHANGED report again for a new UTC day, bundle, user, or a download's head, keeping a row only for a change", async () => {
    const { api, db, applies, outcomes } = await setup();
    const head = () =>
      db.findOne("bundle_event_heads", { install_id: "install-1" });
    const kept = async (n: number) =>
      (
        (await db.findOne("bundle_events", { id: uuid(n) }))?.metadata as
          | { change?: unknown }
          | undefined
      )?.change ?? null;

    await api.recordEvent(unchanged(1));
    await expect(kept(1)).resolves.toEqual({
      kinds: ["first_seen"],
      previous: null,
    });
    // A user switch moves the head; what the installation runs is the same.
    await api.recordEvent(unchanged(2, { user_id: "user-2" }));
    await expect(head()).resolves.toMatchObject({ id: uuid(2) });
    await expect(kept(2)).resolves.toBeNull();
    // A release the installation reports running without an apply report:
    // the report that says so launched it.
    await api.recordEvent(
      unchanged(3, { to_bundle_id: "bundle-3", to_release_id: "release-3" }),
    );
    await expect(head()).resolves.toMatchObject({ id: uuid(3) });
    await expect(kept(3)).resolves.toEqual({
      kinds: ["bundle", "release"],
      previous: {
        bundle_id: "bundle-2",
        release_id: "release-2",
        app_version: "1.0.0",
        channel: "production",
      },
    });
    // Launches go under their own key, which no older UNCHANGED row used.
    await expect(outcomes("UNCHANGED", "on:bundle-3")).resolves.toMatchObject([
      { bucket_start_ms: hour(T), events: 1 },
    ]);
    await expect(outcomes("UNCHANGED", "to:bundle-3")).resolves.toEqual([]);

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
    // The apply report of the downloaded bundle never came: this one did.
    await expect(kept(5)).resolves.toMatchObject({
      kinds: ["bundle", "release"],
      previous: { bundle_id: "bundle-3", release_id: "release-3" },
    });

    await api.recordEvent(
      unchanged(6, {
        to_bundle_id: "bundle-4",
        to_release_id: "release-4",
        received_at_ms: T + DAY,
      }),
    );
    await expect(head()).resolves.toMatchObject({ id: uuid(6) });
    await expect(kept(6)).resolves.toBeNull();
    // Each release counts the launch the report that first ran it made.
    await expect(applies("release-2")).resolves.toBe(0);
    await expect(applies("release-3")).resolves.toBe(1);
    await expect(applies("release-4")).resolves.toBe(1);
  });

  it("keeps an UNCHANGED report for an app version, channel, or release change, and none for an older report", async () => {
    const { api, db, applies, outcomes } = await setup();
    const kept = async (n: number) =>
      (
        (await db.findOne("bundle_events", { id: uuid(n) }))?.metadata as
          | { change?: unknown }
          | undefined
      )?.change ?? null;
    await api.recordEvent(event(1));
    // An App Store update: a new app version on its own built-in bundle.
    await api.recordEvent(
      unchanged(2, {
        app_version: "1.1.0",
        to_bundle_id: "builtin-1.1.0",
        to_release_id: null,
        received_at_ms: T + HOUR,
      }),
    );
    await expect(kept(2)).resolves.toEqual({
      kinds: ["bundle", "release", "app_version"],
      previous: {
        bundle_id: "bundle-2",
        release_id: "release-2",
        app_version: "1.0.0",
        channel: "production",
      },
    });
    // Moving to a built-in bundle with no release launched no release.
    await expect(outcomes("UNCHANGED", "on:builtin-1.1.0")).resolves.toEqual(
      [],
    );
    // A release adopted for the bundle already running: no bundle changed,
    // so it is no launch.
    await api.recordEvent(
      unchanged(3, {
        app_version: "1.1.0",
        to_bundle_id: "builtin-1.1.0",
        to_release_id: "release-embedded",
        received_at_ms: T + 2 * HOUR,
      }),
    );
    await expect(kept(3)).resolves.toMatchObject({ kinds: ["release"] });
    await expect(applies("release-embedded")).resolves.toBe(0);
    // A channel switch.
    await api.recordEvent(
      unchanged(4, {
        app_version: "1.1.0",
        to_bundle_id: "builtin-1.1.0",
        to_release_id: "release-embedded",
        channel: "beta",
        received_at_ms: T + 3 * HOUR,
      }),
    );
    await expect(kept(4)).resolves.toMatchObject({ kinds: ["channel"] });
    // A report older than the head can't say what changed since.
    await api.recordEvent(
      unchanged(5, { to_bundle_id: "bundle-9", received_at_ms: T - HOUR }),
    );
    await expect(kept(5)).resolves.toBeNull();
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({ id: uuid(4) });
  });

  it("counts a forced update's download once when its report lands after the apply, and moves no head with it", async () => {
    const { api, db, lifetime, outcomes } = await setup();
    const head = () =>
      db.findOne("bundle_event_heads", { install_id: "install-1" });
    await api.recordEvent(unchanged(1, { to_bundle_id: "bundle-1" }));
    // The reload after a forced update cut the download report short; the
    // next runtime's apply arrives first.
    await api.recordEvent(event(2, { received_at_ms: T + HOUR }));
    await expect(
      db.findOne("bundle_events", { id: uuid(2) }),
    ).resolves.toMatchObject({ metadata: { implied_download: true } });
    const download = event(3, {
      type: "UPDATE_DOWNLOADED",
      received_at_ms: T + 2 * HOUR,
    });
    await api.recordEvent(download);
    await expect(
      db.findOne("bundle_events", { id: uuid(3) }),
    ).resolves.toMatchObject({ metadata: { late: true }, bundle_ref: [] });
    await expect(head()).resolves.toMatchObject({ id: uuid(2) });
    await expect(lifetime("release-2")).resolves.toEqual({
      downloads: 1,
      launches: 1,
      crashes: 0,
    });
    await expect(outcomes("UPDATE_DOWNLOADED", "to:bundle-2")).resolves.toEqual(
      [],
    );
    // A late apply of the bundle already running counts nothing either.
    await api.recordEvent(event(4, { received_at_ms: T + 3 * HOUR }));
    await expect(
      db.findOne("bundle_events", { id: uuid(4) }),
    ).resolves.toMatchObject({ metadata: { late: true } });
    await expect(lifetime("release-2")).resolves.toMatchObject({
      launches: 1,
    });
  });

  it("keeps no row for a launch report made before the apply its installation already reported", async () => {
    const { api, db } = await setup();
    const made = madeId;
    const applied = event(1, { id: made(2_000_000_000_000, 1) });
    await api.recordEvent(applied);
    // Made before the apply by the runtime that ran bundle-1, delivered
    // after it.
    await api.recordEvent(
      unchanged(2, {
        id: made(1_999_999_999_000, 2),
        to_bundle_id: "bundle-1",
        to_release_id: "release-1",
        received_at_ms: T + HOUR,
      }),
    );
    await expect(
      db.findOne("bundle_events", { id: made(1_999_999_999_000, 2) }),
    ).resolves.toBeNull();
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({ id: applied.id });
  });

  it.each([
    ["a user switch", { user_id: "user-2" }, 0],
    ["the next day's launch", {}, DAY],
  ] as const)(
    "keeps a launch report made before the apply late after %s replaced the apply head",
    async (_case, fields, later) => {
      const { api, db, lifetime, byBundle } = await setup();
      const applyMs = 2_000_000_000_000;
      // Apply bundle-1 → bundle-2.
      await api.recordEvent(event(1, { id: madeId(applyMs, 1) }));
      // A later report on bundle-2 replaces the apply head and keeps no row.
      const later_ = unchanged(2, {
        id: madeId(applyMs + 60_000 + later, 2),
        to_bundle_id: "bundle-2",
        to_release_id: "release-2",
        received_at_ms: T + HOUR + later,
        ...fields,
      });
      await api.recordEvent(later_);
      const head = () =>
        db.findOne("bundle_event_heads", { install_id: "install-1" });
      await expect(head()).resolves.toMatchObject({ id: later_.id });
      const gauges = async () => [
        ...(await byBundle("to_bundle_id", "bundle-1", "UNCHANGED")),
        ...(await byBundle("to_bundle_id", "bundle-2", "UNCHANGED")),
        ...(await byBundle("to_bundle_id", "bundle-2", "UPDATE_APPLIED")),
      ];
      const before = await gauges();
      // Made on bundle-1 before the apply, delivered last.
      const stale = unchanged(3, {
        id: madeId(applyMs - 1_000, 3),
        to_bundle_id: "bundle-1",
        to_release_id: "release-1",
        received_at_ms: T + 2 * HOUR + later,
      });
      await api.recordEvent(stale);
      await expect(
        db.findOne("bundle_events", { id: stale.id }),
      ).resolves.toBeNull();
      await expect(head()).resolves.toMatchObject({ id: later_.id });
      await expect(lifetime("release-1")).resolves.toEqual({
        downloads: 0,
        launches: 0,
        crashes: 0,
      });
      await expect(lifetime("release-2")).resolves.toEqual({
        downloads: 0,
        launches: 1,
        crashes: 0,
      });
      await expect(gauges()).resolves.toEqual(before);
    },
  );

  it("counts a download reported twice before its launch once, and implies none at the launch", async () => {
    const { api, db, lifetime, outcomes } = await setup();
    const download = (n: number, madeMs: number, receivedAtMs: number) =>
      event(n, {
        type: "UPDATE_DOWNLOADED",
        id: madeId(madeMs, n),
        received_at_ms: receivedAtMs,
      });
    const first = download(1, 2_000_000_000_000, T);
    const again = download(2, 2_000_000_060_000, T + HOUR);
    await api.recordEvent(first);
    await api.recordEvent(again);
    await expect(
      db.findOne("bundle_events", { id: again.id }),
    ).resolves.toMatchObject({ metadata: { late: true }, bundle_ref: [] });
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({ id: first.id });
    await expect(lifetime("release-2")).resolves.toEqual({
      downloads: 1,
      launches: 0,
      crashes: 0,
    });

    const applied = event(3, {
      id: madeId(2_000_000_120_000, 3),
      received_at_ms: T + 2 * HOUR,
    });
    await api.recordEvent(applied);
    const row = await db.findOne("bundle_events", { id: applied.id });
    expect(row?.metadata).not.toHaveProperty("implied_download");
    await expect(lifetime("release-2")).resolves.toEqual({
      downloads: 1,
      launches: 1,
      crashes: 0,
    });
    // One download hour: the first report's.
    await expect(outcomes("UPDATE_DOWNLOADED", "to:bundle-2")).resolves.toEqual(
      [expect.objectContaining({ events: 1 })],
    );
  });

  it("launches a release with no implied download when it runs the native build's built-in bundle, and keeps a native build change", async () => {
    const { api, db, lifetime } = await setup();
    const build = (minBundleId: string) => ({
      ...unchanged(0).metadata,
      min_bundle_id: minBundleId,
    });
    await api.recordEvent(
      event(1, {
        metadata: { ...event(1).metadata, min_bundle_id: "builtin-a" },
      } as Partial<BundleEventRow>),
    );
    // A rollback to the built-in bundle, released as its own release.
    await api.recordEvent(
      unchanged(2, {
        to_bundle_id: "builtin-a",
        to_release_id: "release-embedded",
        metadata: build("builtin-a"),
        received_at_ms: T + HOUR,
      }),
    );
    await expect(lifetime("release-embedded")).resolves.toEqual({
      downloads: 0,
      launches: 1,
      crashes: 0,
    });
    // An App Store build of the same version, still running that release.
    // Its SDK reports the same fields again only the next UTC day.
    await api.recordEvent(
      unchanged(3, {
        to_bundle_id: "builtin-a",
        to_release_id: "release-embedded",
        metadata: build("builtin-b"),
        received_at_ms: T + DAY,
      }),
    );
    await expect(
      db.findOne("bundle_events", { id: uuid(3) }),
    ).resolves.toMatchObject({
      metadata: {
        change: {
          kinds: ["native_build"],
          previous: { min_bundle_id: "builtin-a" },
        },
      },
    });
  });

  it("counts no UNCHANGED row kept before launches had their own key", () => {
    const older = {
      ...unchanged(1),
      to_bundle_id: "bundle-2",
    } as BundleEventRow;
    // Rows older RCs kept for every launch carry no change, so no bundle
    // filter, outcome series, or counter reads them as launches.
    expect(bundleRefsOf(older)).toEqual([]);
    expect(
      matchesInsightsEventFilter(older, {
        kind: "bundle",
        platform: "ios",
        channel: "production",
        type: "UNCHANGED",
        toBundleId: "bundle-2",
      }),
    ).toBe(false);
    expect(isLaunch(older)).toBe(false);
  });

  it("records an update failure for its target release and channel, and moves no head", async () => {
    const {
      api,
      db,
      overview,
      sketch,
      outcomes,
      everyEvent,
      failures,
      failedUsers,
    } = await setup();
    await api.recordEvent(event(1, { install_id: "install-2" }));
    const failed = {
      stage: "download",
      reason: "http",
      resource: "artifact",
      http_status: 403,
      origin_code: "AccessDenied",
    };
    await api.recordEvent(failure(2, failed));

    await expect(
      db.findOne("bundle_events", { id: uuid(2) }),
    ).resolves.toMatchObject({
      movement_install_id: "install-2",
      bundle_ref: ["to:bundle-3"],
    });
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-2" }),
    ).resolves.toMatchObject({ id: uuid(1), type: "UPDATE_APPLIED" });
    await expect(
      outcomes("UPDATE_FAILED", "to:bundle-3"),
    ).resolves.toMatchObject([{ bucket_start_ms: hour(T), events: 1 }]);
    await expect(everyEvent()).resolves.toMatchObject([{ events: 2 }]);
    await expect(
      api.listEvents({
        filter: { kind: "installationMovement", installId: "install-2" },
        beforeReceivedAtMs: T + HOUR,
        limit: 10,
      }),
    ).resolves.toMatchObject([{ id: uuid(2) }, { id: uuid(1) }]);

    const release = {
      scopeKind: "release",
      releaseKind: "specific",
      releaseId: "release-3",
    } as const;
    // Only the lifetime row counts the failure: windowed reads sum the
    // breakdown's hourly rows.
    await expect(
      overview(identity({ ...release, periodKind: "lifetime" }), 0, "lifetime"),
    ).resolves.toMatchObject({ failed_updates: 1, applies: 0 });
    await expect(
      overview(identity({ ...release, periodKind: "hour" }), hour(T)),
    ).resolves.toBeUndefined();
    for (const [periodKind, bucket] of [
      ["hour", hour(T)],
      ["lifetime", 0],
    ] as const) {
      await expect(
        failedUsers(
          identity({ ...release, scopeKind: "failure", periodKind }),
          bucket,
          periodKind,
        ),
      ).resolves.toBe(1);
    }
    for (const [periodKind, bucket] of [
      ["hour", hour(T)],
      ["day", day(T)],
    ] as const) {
      // A failure is no launch, and no counter: the channel's rows count
      // neither it nor the apply's launch, which its release's lifetime row
      // counts.
      await expect(
        overview(identity({ periodKind }), bucket, periodKind),
      ).resolves.toBeUndefined();
      await expect(
        failedUsers(
          identity({ scopeKind: "failure", periodKind }),
          bucket,
          periodKind,
        ),
      ).resolves.toBe(1);
      // Nor activity: install-2 counts once, from its apply.
      const usage = await sketch(
        identity({ scopeKind: "usage", periodKind }),
        bucket,
        periodKind,
      );
      expect(countDistinct(usage!.activity_users)).toBe(1);
    }
    await expect(failures()).resolves.toEqual([
      {
        platform: "ios",
        channel: "production",
        bucket_start_ms: hour(T),
        release_id: "release-3",
        stage: "download",
        reason: "http",
        detail: JSON.stringify(["artifact", 403, "AccessDenied", null]),
        events: 1,
      },
    ]);
  });

  it("counts a failed check for its channel only, and in no bundle list", async () => {
    const { api, db, overview, outcomes, everyEvent, failures, failedUsers } =
      await setup();
    await api.recordEvent(
      failure(
        1,
        { stage: "check", reason: "invalid_response", resource: "catalog" },
        { to_release_id: null, to_bundle_id: "bundle-2" },
      ),
    );

    await expect(
      db.findOne("bundle_events", { id: uuid(1) }),
    ).resolves.toMatchObject({
      movement_install_id: "install-2",
      bundle_ref: [],
    });
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-2" }),
    ).resolves.toBeNull();
    await expect(outcomes("UPDATE_FAILED", "to:bundle-2")).resolves.toEqual([]);
    await expect(everyEvent()).resolves.toMatchObject([{ events: 1 }]);
    const scope = { platform: "ios", channel: "production" } as const;
    await expect(
      api.listEvents({
        filter: {
          kind: "bundle",
          ...scope,
          type: "UPDATE_FAILED",
          toBundleId: "bundle-2",
        },
        sinceMs: day(T),
        beforeReceivedAtMs: T + HOUR,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      api.listEvents({
        filter: { kind: "all" },
        sinceMs: day(T),
        beforeReceivedAtMs: T + HOUR,
        limit: 10,
      }),
    ).resolves.toMatchObject([{ id: uuid(1) }]);
    for (const [periodKind, bucket] of [
      ["hour", hour(T)],
      ["day", day(T)],
    ] as const) {
      await expect(
        overview(identity({ periodKind }), bucket, periodKind),
      ).resolves.toBeUndefined();
      await expect(
        failedUsers(
          identity({ scopeKind: "check", periodKind }),
          bucket,
          periodKind,
        ),
      ).resolves.toBe(1);
      await expect(
        failedUsers(
          identity({ scopeKind: "failure", periodKind }),
          bucket,
          periodKind,
        ),
      ).resolves.toBe(0);
    }
    await expect(failures()).resolves.toMatchObject([
      {
        release_id: "",
        stage: "check",
        reason: "invalid_response",
        detail: JSON.stringify(["catalog", null, null, null]),
        events: 1,
      },
    ]);
  });

  it("counts a download a patch delivered, and one that fell back from a patch", async () => {
    const { api, overview } = await setup();
    const download = (n: number, metadata: Record<string, unknown>) =>
      event(n, {
        type: "UPDATE_DOWNLOADED",
        install_id: `install-${n}`,
        metadata: { ...event(n).metadata, ...metadata },
      } as Partial<BundleEventRow>);
    await api.recordEvent(download(1, { delivery: "patch" }));
    await api.recordEvent(
      download(2, { delivery: "archive", patch_fallback: true }),
    );
    await api.recordEvent(download(3, { delivery: "manifest" }));

    const counted = { downloads: 3, patch_downloads: 1, patch_fallbacks: 1 };
    const release = {
      scopeKind: "release",
      releaseKind: "specific",
      releaseId: "release-2",
    } as const;
    await expect(
      overview(identity({ ...release, periodKind: "hour" }), hour(T)),
    ).resolves.toMatchObject(counted);
    await expect(
      overview(identity({ ...release, periodKind: "lifetime" }), 0, "lifetime"),
    ).resolves.toMatchObject(counted);
    await expect(
      overview(identity({ periodKind: "day" }), day(T), "day"),
    ).resolves.toMatchObject(counted);
  });

  it("keeps no failure breakdown row for a recovery", async () => {
    const { api, failures } = await setup();
    await api.recordEvent(event(1, { type: "RECOVERED" }));

    await expect(failures()).resolves.toEqual([]);
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
    // Each step applies its own bundle, so none arrives for a bundle its
    // installation already runs.
    const events = installs.flatMap((install, position) =>
      [0, 1, 2].map((step) =>
        event(position * 10 + step + 1, {
          install_id: `install-${install}`,
          to_release_id: `release-${install}-${step}`,
          to_bundle_id: `bundle-${install}-${step}`,
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
