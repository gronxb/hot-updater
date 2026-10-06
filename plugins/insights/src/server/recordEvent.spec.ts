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

import {
  insights,
  insightsIdentity,
  type InsightsIdentityParts,
  type InsightsSchema,
  type BundleEventRow,
} from "./index";
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
    /** A release's applies: only its lifetime row counts them. */
    const applies = async (releaseId: string) =>
      (
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
      ).rows[0]?.applies ?? 0;
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
    await api.recordEvent(event(3, { received_at_ms: T + HOUR }));

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

  it("records an UNCHANGED report as a launch that no event, outcome, or release counter keeps", async () => {
    const { api, db, applies, outcomes, everyEvent, byBundle } = await setup();
    await api.recordEvent(unchanged(1));

    await expect(db.findOne("bundle_events", { id: uuid(1) })).resolves.toBe(
      null,
    );
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toEqual(unchanged(1));
    await expect(outcomes("UNCHANGED", "to:bundle-2")).resolves.toEqual([]);
    await expect(everyEvent()).resolves.toEqual([]);
    // A launch keeps running its bundle: it applies nothing.
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
    ).resolves.toEqual([]);
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

    // An UNCHANGED report keeps no event row, so a retry that lands the next
    // UTC day is known by the head's id.
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

  it("records an UNCHANGED report again for a new UTC day, bundle, user, or a download's head", async () => {
    const { api, db, applies } = await setup();
    const head = () =>
      db.findOne("bundle_event_heads", { install_id: "install-1" });

    await api.recordEvent(unchanged(1));
    await api.recordEvent(unchanged(2, { user_id: "user-2" }));
    await expect(head()).resolves.toMatchObject({ id: uuid(2) });
    await api.recordEvent(
      unchanged(3, { to_bundle_id: "bundle-3", to_release_id: "release-3" }),
    );
    await expect(head()).resolves.toMatchObject({ id: uuid(3) });

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
    // Launches, even on a bundle that was downloaded, apply nothing.
    for (const releaseId of ["release-2", "release-3", "release-4"])
      await expect(applies(releaseId)).resolves.toBe(0);
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
