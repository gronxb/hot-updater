import {
  addDistinct,
  compareUtf8,
  extractTimestampFromUUIDv7,
  type HotUpdaterDatabase,
  type HotUpdaterTransaction,
  isUUIDv7,
} from "@hot-updater/plugin-core";

import { assertBundleEventRow } from "./contract";
import {
  type BundleEventChange,
  type BundleEventChangeKind,
  type BundleEventFailure,
  type BundleEventRow,
  runningBuiltinBundleId,
} from "./eventRow";
import {
  insightsKey,
  insightsOverviewDeltas,
  insightsOverviewId,
  type InsightsOverviewIdentity,
} from "./overview";
import {
  bundleRefOfFilter,
  bundleRefsOf,
  DAILY_EVENTS,
  DAY_MS,
  HOUR_MS,
  type InsightsSchema,
  isLaunch,
} from "./schema";

/** The head columns `countHead` and `repeatsHead` read. */
interface Head {
  readonly install_id: string;
  readonly id: string;
  readonly received_at_ms: number;
  readonly platform: string;
  readonly channel: string;
  readonly type: string;
  readonly user_id: string | null;
  readonly from_release_id: string | null;
  readonly from_bundle_id: string | null;
  readonly to_release_id: string | null;
  readonly to_bundle_id: string;
  readonly app_version: string;
  readonly metadata: unknown;
}

const hourOf = (ms: number) => ms - (ms % HOUR_MS);
const dayOf = (ms: number) => ms - (ms % DAY_MS);

/**
 * An overview or sketch row's scope and period; day periods roll up channel
 * and usage rows. The `failure` and `check` scopes key the sketches of
 * installations whose update, or whose update check, failed.
 */
export type InsightsIdentityParts = Omit<
  InsightsOverviewIdentity,
  "bucketStartMs" | "periodKind" | "scopeKind"
> & {
  readonly scopeKind:
    | InsightsOverviewIdentity["scopeKind"]
    | "failure"
    | "check";
  readonly periodKind: InsightsOverviewIdentity["periodKind"] | "day";
};

/** The `identity` of an overview or sketch row: its scope and period, hashed. */
export const insightsIdentity = (identity: InsightsIdentityParts): string =>
  insightsOverviewId({
    ...identity,
    scopeKind: identity.scopeKind as InsightsOverviewIdentity["scopeKind"],
    periodKind: identity.periodKind as InsightsOverviewIdentity["periodKind"],
    bucketStartMs: 0,
  });

/**
 * The bucket a head's gauges count it in, the UTC day of its event, and what
 * its distribution row names: the release it runs, which a download leaves
 * at its source, and the built-in bundle, when it runs the native build's.
 * A head stored without the built-in bundle ID counts in no built-in row, so
 * taking it back moves none.
 */
const gaugeSlot = (head: Head) => ({
  bucket: dayOf(head.received_at_ms),
  releaseId:
    head.type === "UPDATE_DOWNLOADED"
      ? head.from_release_id
      : head.to_release_id,
  builtinBundleId: runningBuiltinBundleId(head),
});

/**
 * The `insights_latest_by_bundle` field of a head's (from, to) pair. A head
 * matches a `from` and a `to` predicate of one type at once only through its
 * pair, so this gauge is what a count subtracts to count it once.
 */
export const PAIR_FIELD = "from_to";

/** The pair gauge's `bundle_id`: a hash of the two bundle ids, which fit no single 36-character column. */
export const bundlePairKey = (from: string, to: string): string =>
  insightsKey(`${from.length}:${from}${to.length}:${to}`);

/**
 * Moves a head's gauges: the distribution row, and the built-in one when it
 * runs its build's built-in bundle, one row per bundle it references, and
 * its pair; -1 takes back the head an event replaces.
 */
const countHead = (
  tx: HotUpdaterTransaction<InsightsSchema>,
  head: Head,
  delta: 1 | -1,
) => {
  const { bucket, releaseId, builtinBundleId } = gaugeSlot(head);
  const shardBy = head.install_id;
  tx.aggregate(
    "insights_distribution",
    {
      channel: head.channel,
      platform: head.platform,
      app_version: head.app_version,
      release_id: releaseId ?? "",
      bucket_start_ms: bucket,
    },
    { latest_installations: delta },
    { shardBy },
  );
  if (builtinBundleId !== null) {
    tx.aggregate(
      "insights_builtin_distribution",
      {
        channel: head.channel,
        platform: head.platform,
        app_version: head.app_version,
        release_id: releaseId ?? "",
        builtin_bundle_id: builtinBundleId,
        bucket_start_ms: bucket,
      },
      { latest_installations: delta },
      { shardBy },
    );
  }
  for (const field of ["from_bundle_id", "to_bundle_id"] as const) {
    const bundleId = head[field];
    if (bundleId === null) continue;
    tx.aggregate(
      "insights_latest_by_bundle",
      {
        platform: head.platform,
        channel: head.channel,
        bundle_field: field,
        bundle_id: bundleId,
        type: head.type,
        bucket_start_ms: bucket,
      },
      { installations: delta },
      { shardBy },
    );
  }
  if (head.from_bundle_id !== null) {
    tx.aggregate(
      "insights_latest_by_bundle",
      {
        platform: head.platform,
        channel: head.channel,
        bundle_field: PAIR_FIELD,
        bundle_id: bundlePairKey(head.from_bundle_id, head.to_bundle_id),
        type: head.type,
        bucket_start_ms: bucket,
      },
      { installations: delta },
      { shardBy },
    );
  }
};

/**
 * Where each period's rows go, each with its retention: hours for 90 days,
 * days for 13 months, and a release's lifetime counters kept.
 */
const PERIOD_MODELS = {
  hour: { counters: "insights_overview", sketches: "insights_sketches" },
  day: {
    counters: "insights_overview_daily",
    sketches: "insights_sketches_daily",
  },
  lifetime: { counters: "insights_overview_lifetime", sketches: undefined },
} as const;

/** A download's patch counters: a patch delivered it, or it fell back from one. */
const patchCounters = (event: BundleEventRow) =>
  event.type !== "UPDATE_DOWNLOADED"
    ? {}
    : {
        ...(event.metadata.delivery === "patch" ? { patch_downloads: 1 } : {}),
        ...(event.metadata.patch_fallback === true
          ? { patch_fallbacks: 1 }
          : {}),
      };

/**
 * Counters and sketches for one event: release, channel, and usage rows, with
 * day rollups for channel and usage. Only usage rows keep a sketch, of active
 * installations, and only for the event's platform, since a read for every
 * platform merges the ios and android sketches. A download's patch counters
 * go in the rows that count it.
 */
const countEvent = (
  tx: HotUpdaterTransaction<InsightsSchema>,
  event: BundleEventRow,
) => {
  const shardBy = event.install_id;
  for (const delta of insightsOverviewDeltas(event)) {
    if (delta.identity.platform === "all") continue;
    const { bucketStartMs, ...parts } = delta.identity;
    const periods =
      parts.scopeKind === "channel" || parts.scopeKind === "usage"
        ? ([
            ["hour", bucketStartMs],
            ["day", dayOf(event.received_at_ms)],
          ] as const)
        : ([[parts.periodKind, bucketStartMs]] as const);
    for (const [periodKind, bucket] of periods) {
      const models = PERIOD_MODELS[periodKind as keyof typeof PERIOD_MODELS];
      const key = {
        identity: insightsIdentity({ ...parts, periodKind }),
        bucket_start_ms: bucket,
      };
      const counters: {
        downloads?: number;
        applies?: number;
        failed_launches?: number;
        patch_downloads?: number;
        patch_fallbacks?: number;
      } = {
        ...Object.fromEntries(
          [
            ["downloads", delta.downloads],
            ["applies", delta.applies],
            ["failed_launches", delta.failedLaunches],
          ].filter(([, value]) => value !== 0),
        ),
        ...(delta.downloads === 0 ? {} : patchCounters(event)),
      };
      if (Object.keys(counters).length > 0) {
        tx.aggregate(models.counters, key, counters, { shardBy });
      }
      if (
        models.sketches !== undefined &&
        delta.activityIdentity !== undefined
      ) {
        tx.aggregate(
          models.sketches,
          key,
          { activity_users: addDistinct(null, delta.activityIdentity) },
          { shardBy },
        );
      }
    }
  }
};

/**
 * A stored event's outcome rows: its bundle filter's hour, when it has one
 * (`bundleRefsOf`), and every stored event's UTC day. A download that a
 * launch or crash implied counts in its bundle's download hour too, in the
 * hour of that launch or crash, so the download series covers what the
 * release's downloads count; the launch or crash is its row.
 */
const countOutcome = (
  tx: HotUpdaterTransaction<InsightsSchema>,
  event: BundleEventRow,
) => {
  const shardBy = event.install_id;
  const hour = (type: string, bundleRef: string) =>
    tx.aggregate(
      "insights_outcomes",
      {
        platform: event.platform,
        channel: event.channel,
        type,
        bundle_ref: bundleRef,
        bucket_start_ms: hourOf(event.received_at_ms),
      },
      { events: 1 },
      { shardBy },
    );
  for (const bundleRef of bundleRefsOf(event)) hour(event.type, bundleRef);
  if (event.metadata.implied_download === true) {
    hour(
      "UPDATE_DOWNLOADED",
      bundleRefOfFilter({
        type: "UPDATE_DOWNLOADED",
        toBundleId:
          event.type === "RECOVERED"
            ? event.from_bundle_id!
            : event.to_bundle_id,
      }),
    );
  }
  // The global event list reads only the days this row counts: a gap costs
  // it one empty day and one read of this row, not a read a day. One more
  // blind increment per event, on the event's shard like the others.
  tx.aggregate(
    "insights_outcomes",
    { ...DAILY_EVENTS, bucket_start_ms: dayOf(event.received_at_ms) },
    { events: 1 },
    { shardBy },
  );
};

/** The row check requires an UPDATE_FAILED row's failure; its type leaves it optional. */
const UNKNOWN_FAILURE: BundleEventFailure = {
  stage: "unknown",
  reason: "unknown",
};

/** A failure's `detail`: what else the client knew, as a JSON array. */
const failureDetail = (failure: BundleEventFailure): string =>
  JSON.stringify([
    failure.resource ?? null,
    failure.http_status ?? null,
    failure.origin_code ?? null,
    failure.transport ?? null,
  ]);

/**
 * An update failure's sketches, breakdown row, and lifetime counter. Its
 * hourly breakdown row is what windowed reads sum, so no hourly or daily
 * counter repeats it. A failed check counts for its channel, in the `check`
 * sketch of installations. Any other failure counts in the channel's
 * `failure` sketch, and for its target release, when it names one, in the
 * release's hourly and lifetime `failure` sketches and its lifetime
 * `failed_updates`, which the bundle detail reads. A failure is no launch
 * and no activity: the installation reports its launch that day.
 */
const countFailure = (
  tx: HotUpdaterTransaction<InsightsSchema>,
  event: BundleEventRow & { readonly type: "UPDATE_FAILED" },
) => {
  const shardBy = event.install_id;
  const failure = event.metadata.failure ?? UNKNOWN_FAILURE;
  const check = failure.stage === "check";
  const hour = hourOf(event.received_at_ms);
  const scope = {
    channel: event.channel,
    platform: event.platform,
    appVersionKind: "all",
    appVersion: "",
  } as const;
  const channel = { ...scope, releaseKind: "all", releaseId: "" } as const;
  const users = { failed_users: addDistinct(null, event.install_id) };
  for (const [periodKind, bucket] of [
    ["hour", hour],
    ["day", dayOf(event.received_at_ms)],
  ] as const) {
    const identity = insightsIdentity({
      ...channel,
      scopeKind: check ? "check" : "failure",
      periodKind,
    });
    tx.aggregate(
      PERIOD_MODELS[periodKind].sketches,
      { identity, bucket_start_ms: bucket },
      users,
      { shardBy },
    );
  }
  const releaseId = check ? null : event.to_release_id;
  if (releaseId !== null) {
    const release = { ...scope, releaseKind: "specific", releaseId } as const;
    for (const [periodKind, bucket, sketches] of [
      ["hour", hour, "insights_sketches"],
      ["lifetime", 0, "insights_sketches_lifetime"],
    ] as const) {
      const key = (scopeKind: InsightsIdentityParts["scopeKind"]) => ({
        identity: insightsIdentity({ ...release, scopeKind, periodKind }),
        bucket_start_ms: bucket,
      });
      tx.aggregate(sketches, key("failure"), users, { shardBy });
    }
    tx.aggregate(
      "insights_overview_lifetime",
      {
        identity: insightsIdentity({
          ...release,
          scopeKind: "release",
          periodKind: "lifetime",
        }),
        bucket_start_ms: 0,
      },
      { failed_updates: 1 },
      { shardBy },
    );
  }
  tx.aggregate(
    "insights_failures",
    {
      platform: event.platform,
      channel: event.channel,
      bucket_start_ms: hour,
      release_id: releaseId ?? "",
      stage: failure.stage,
      reason: failure.reason,
      detail: failureDetail(failure),
    },
    { events: 1 },
    { shardBy },
  );
};

const isNewer = (event: Head, head: Head) =>
  event.received_at_ms !== head.received_at_ms
    ? event.received_at_ms > head.received_at_ms
    : compareUtf8(event.id, head.id) > 0;

/** What a head says its installation runs: a download leaves it at the source. */
const runningOf = (head: Head) =>
  head.type === "UPDATE_DOWNLOADED"
    ? { bundle_id: head.from_bundle_id!, release_id: head.from_release_id }
    : { bundle_id: head.to_bundle_id, release_id: head.to_release_id };

/** The native build a report or head came from, when its SDK says. */
const minBundleIdOf = (row: { readonly metadata: unknown }) =>
  (row.metadata as { min_bundle_id?: string } | null)?.min_bundle_id;

/** When the client made a report, from the UUIDv7 it gave it. */
const madeAt = (id: string) =>
  isUUIDv7(id) ? extractTimestampFromUUIDv7(id) : null;

/**
 * A report that arrived after its installation moved past it: a download or
 * an apply of the bundle the head already runs, or an UNCHANGED report of the
 * bundle an apply head left, made before that apply. A reload can cut one
 * runtime's report short and deliver it after the next runtime's. It stays
 * in history but moves and counts nothing.
 */
const isLate = (event: BundleEventRow, head: Head | null): boolean => {
  if (head === null) return false;
  if (event.type === "UPDATE_DOWNLOADED" || event.type === "UPDATE_APPLIED") {
    return event.to_bundle_id === runningOf(head).bundle_id;
  }
  if (
    event.type === "UNCHANGED" &&
    head.type === "UPDATE_APPLIED" &&
    event.to_bundle_id === head.from_bundle_id
  ) {
    const made = madeAt(event.id);
    const applied = madeAt(head.id);
    return made !== null && applied !== null && made < applied;
  }
  return false;
};

/**
 * What an UNCHANGED report changes against its installation's head: the
 * running bundle or release, the app version, the channel, or the native
 * build (when both name it), with the head's values before it; `first_seen`
 * when the installation has no head. A report the head already answers, one
 * older than the head, a user switch and any other event type change
 * nothing, so no row keeps them.
 */
const changeOf = (
  event: BundleEventRow,
  head: Head | null,
): BundleEventChange | null => {
  if (event.type !== "UNCHANGED") return null;
  if (head === null) return { kinds: ["first_seen"], previous: null };
  if (!isNewer(event, head)) return null;
  const running = runningOf(head);
  const build = minBundleIdOf(event);
  const headBuild = minBundleIdOf(head);
  const kinds: BundleEventChangeKind[] = [];
  if (event.to_bundle_id !== running.bundle_id) kinds.push("bundle");
  if (event.to_release_id !== running.release_id) kinds.push("release");
  if (event.app_version !== head.app_version) kinds.push("app_version");
  if (event.channel !== head.channel) kinds.push("channel");
  if (build !== undefined && headBuild !== undefined && build !== headBuild) {
    kinds.push("native_build");
  }
  return kinds.length === 0
    ? null
    : {
        kinds,
        previous: {
          bundle_id: running.bundle_id,
          release_id: running.release_id,
          app_version: head.app_version,
          channel: head.channel,
          ...(headBuild === undefined ? {} : { min_bundle_id: headBuild }),
        },
      };
};

/**
 * Whether a launch or a crash comes with no download report for its target:
 * its head shows neither that download nor the target already running. The
 * native build's built-in bundle is never downloaded, and without a head the
 * server knows nothing of the installation's past, so it implies nothing.
 */
const impliesDownload = (event: BundleEventRow, head: Head | null): boolean => {
  const target =
    event.type === "RECOVERED"
      ? { bundle: event.from_bundle_id, release: event.from_release_id }
      : isLaunch(event)
        ? { bundle: event.to_bundle_id, release: event.to_release_id }
        : null;
  if (
    target === null ||
    target.release === null ||
    target.bundle === minBundleIdOf(event)
  ) {
    return false;
  }
  if (head === null) return false;
  if (
    head.type === "UPDATE_DOWNLOADED" &&
    head.to_bundle_id === target.bundle
  ) {
    return false;
  }
  return runningOf(head).bundle_id !== target.bundle;
};

/**
 * The event as recorded, with what only the server sets: what a kept
 * UNCHANGED report changed, a late report's flag, and a download its launch
 * or crash implied.
 */
const recordedOf = (
  event: BundleEventRow,
  head: Head | null,
): { readonly recorded: BundleEventRow; readonly late: boolean } => {
  const {
    change: _change,
    late: _late,
    implied_download: _implied,
    ...metadata
  } = event.metadata;
  const reported = { ...event, metadata } as BundleEventRow;
  const late = isLate(reported, head);
  const change = late ? null : changeOf(reported, head);
  const withChange = (
    change === null
      ? reported
      : { ...reported, metadata: { ...metadata, change } }
  ) as BundleEventRow;
  const recorded = (
    late && reported.type !== "UNCHANGED"
      ? { ...reported, metadata: { ...metadata, late: true } }
      : !late && impliesDownload(withChange, head)
        ? {
            ...withChange,
            metadata: { ...withChange.metadata, implied_download: true },
          }
        : withChange
  ) as BundleEventRow;
  return { recorded, late };
};

/** What an UNCHANGED report must share with its installation's head to repeat it. */
const REPEATED_FIELDS = [
  "channel",
  "platform",
  "app_version",
  "to_bundle_id",
  "to_release_id",
  "user_id",
] as const;

/**
 * An UNCHANGED report that repeats its installation's head from the same UTC
 * day: the installation already counts as active that day, on that bundle,
 * so the report records nothing. A download's head does not count, because
 * its installation still ran the bundle it downloaded from.
 */
const repeatsHead = (event: BundleEventRow, head: Head) =>
  event.type === "UNCHANGED" &&
  head.type !== "UPDATE_DOWNLOADED" &&
  dayOf(event.received_at_ms) === dayOf(head.received_at_ms) &&
  REPEATED_FIELDS.every((field) => event[field] === head[field]);

/**
 * Records one event in one transaction: one batch read of the event and its
 * installation's head, one of the gauge and sketch rows it changes, then one
 * write. On a database that batches aggregates (DynamoDB, Firestore), the
 * write holds the event's rows and one log row instead, and a compaction
 * reads and writes the aggregate rows. A stored event's id changes nothing
 * when repeated, whichever installation sends it, and neither does the id
 * of the installation's head. An UNCHANGED report that repeats its head on
 * the same UTC day writes nothing at all. An older event still counts in its
 * own hour but never replaces the head. An update failure is stored and
 * counted, but changes what no installation runs, so it moves no head.
 */
export const recordEvent = (
  db: HotUpdaterDatabase<InsightsSchema>,
  event: BundleEventRow,
): Promise<void> => {
  assertBundleEventRow(event);
  return db.transaction(async (tx) => {
    const [existing, previous] = await Promise.all([
      tx.findOne("bundle_events", { id: event.id }),
      tx.findOne("bundle_event_heads", { install_id: event.install_id }),
    ]);
    // The id is the report's idempotency key: a retry, or any report under
    // an id already stored or already the installation's head, changes
    // nothing, as analytics ingestion drops duplicates.
    if (existing !== null || previous?.id === event.id) return;
    if (previous !== null && repeatsHead(event, previous)) return;
    // An UNCHANGED report is a launch: it counts and moves the head. A row
    // keeps it only when it changes what the installation runs, or is the
    // installation's first report, so installation history and All Events
    // show each change once. A late report moves no head.
    const { recorded, late } = recordedOf(event, previous);
    if (
      recorded.type !== "UNCHANGED" ||
      (recorded.metadata.change !== undefined && !late)
    ) {
      tx.create("bundle_events", recorded);
      countOutcome(tx, recorded);
    }
    if (recorded.type === "UPDATE_FAILED") {
      countFailure(tx, recorded);
      return;
    }
    countEvent(tx, recorded);
    if (previous !== null && (late || !isNewer(recorded, previous))) return;
    if (previous === null) {
      tx.create("bundle_event_heads", recorded);
    } else {
      const { install_id: _, ...fields } = recorded;
      countHead(tx, previous, -1);
      tx.update("bundle_event_heads", previous, fields);
    }
    countHead(tx, recorded, 1);
  });
};
