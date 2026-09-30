import { addDistinct, compareUtf8 } from "@hot-updater/plugin-core/internal";

import type {
  HotUpdaterDatabase,
  HotUpdaterTransaction,
} from "../../database/database";
import { assertBundleEventRow } from "./contract";
import type { BundleEventFailure, BundleEventRow } from "./eventRow";
import {
  insightsKey,
  insightsOverviewDeltas,
  insightsOverviewId,
  type InsightsOverviewIdentity,
} from "./overview";
import {
  DAILY_EVENTS,
  DAY_MS,
  HOUR_MS,
  isFailedCheck,
  type InsightsSchema,
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
 * The bucket a head's gauges count it in, the UTC day of its event, and the
 * release its distribution row names: the one it runs, which a download
 * leaves at its source.
 */
const gaugeSlot = (head: Head) => ({
  bucket: dayOf(head.received_at_ms),
  releaseId:
    head.type === "UPDATE_DOWNLOADED"
      ? head.from_release_id
      : head.to_release_id,
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
 * Moves a head's gauges: the distribution row, one row per bundle it
 * references, and its pair; -1 takes back the head an event replaces.
 */
const countHead = (
  tx: HotUpdaterTransaction<InsightsSchema>,
  head: Head,
  delta: 1 | -1,
) => {
  const { bucket, releaseId } = gaugeSlot(head);
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
 * day rollups for channel and usage. Usage rows are written for the event's
 * platform only, since a read for every platform merges the ios and android
 * sketches; a channel's active installations come from its usage rows, so
 * channel rows keep no sketch of their own. A download's patch counters go
 * in the rows that count it.
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
        launches?: number;
        failed_launches?: number;
        patch_downloads?: number;
        patch_fallbacks?: number;
      } = {
        ...Object.fromEntries(
          [
            ["downloads", delta.downloads],
            ["launches", delta.launches],
            ["failed_launches", delta.failedLaunches],
          ].filter(([, value]) => value !== 0),
        ),
        ...(delta.downloads === 0 ? {} : patchCounters(event)),
      };
      if (Object.keys(counters).length > 0) {
        tx.aggregate(models.counters, key, counters, { shardBy });
      }
      const sketches = {
        ...(delta.launchIdentity === undefined || parts.scopeKind === "channel"
          ? {}
          : { launch_users: addDistinct(null, delta.launchIdentity) }),
        ...(delta.activityIdentity === undefined
          ? {}
          : {
              activity_users: addDistinct(null, delta.activityIdentity),
            }),
      };
      if (models.sketches !== undefined && Object.keys(sketches).length > 0) {
        tx.aggregate(models.sketches, key, sketches, { shardBy });
      }
    }
  }
};

/**
 * A stored event's outcome rows: its bundle filter's hour, which a failed
 * check has none of, and every stored event's UTC day.
 */
const countOutcome = (
  tx: HotUpdaterTransaction<InsightsSchema>,
  event: BundleEventRow,
) => {
  const shardBy = event.install_id;
  if (!isFailedCheck(event)) {
    tx.aggregate(
      "insights_outcomes",
      {
        platform: event.platform,
        channel: event.channel,
        type: event.type,
        bundle_ref:
          event.type === "RECOVERED"
            ? `from:${event.from_bundle_id}`
            : `to:${event.to_bundle_id}`,
        bucket_start_ms: hourOf(event.received_at_ms),
      },
      { events: 1 },
      { shardBy },
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
 * An update failure's counters, sketches, and breakdown row. A failed check
 * counts for its channel: its `check_failures` and the `check` sketch of
 * installations. Any other failure counts `failed_updates` and the
 * `failure` sketch for its channel, and for its target release, when it
 * names one, by hour and since the release's first failure. A failure is no
 * launch and no activity: the installation reports its launch that day.
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
  const counted = check ? { check_failures: 1 } : { failed_updates: 1 };
  for (const [periodKind, bucket] of [
    ["hour", hour],
    ["day", dayOf(event.received_at_ms)],
  ] as const) {
    const models = PERIOD_MODELS[periodKind];
    const key = (scopeKind: InsightsIdentityParts["scopeKind"]) => ({
      identity: insightsIdentity({ ...channel, scopeKind, periodKind }),
      bucket_start_ms: bucket,
    });
    tx.aggregate(models.counters, key("channel"), counted, { shardBy });
    tx.aggregate(models.sketches, key(check ? "check" : "failure"), users, {
      shardBy,
    });
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
      tx.aggregate(
        PERIOD_MODELS[periodKind].counters,
        key("release"),
        { failed_updates: 1 },
        { shardBy },
      );
      tx.aggregate(sketches, key("failure"), users, { shardBy });
    }
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

/**
 * A recovery's exit reason, which Android 11+ reports, in the breakdown of
 * the release whose launch failed: stage `launch`, the reason as its reason.
 */
const countExit = (
  tx: HotUpdaterTransaction<InsightsSchema>,
  event: BundleEventRow,
) => {
  const exit = event.metadata.previous_process_exit;
  if (event.type !== "RECOVERED" || exit === undefined) return;
  tx.aggregate(
    "insights_failures",
    {
      platform: event.platform,
      channel: event.channel,
      bucket_start_ms: hourOf(event.received_at_ms),
      release_id: event.from_release_id ?? "",
      stage: "launch",
      reason: exit,
      detail: "",
    },
    { events: 1 },
    { shardBy: event.install_id },
  );
};

const isNewer = (event: Head, head: Head) =>
  event.received_at_ms !== head.received_at_ms
    ? event.received_at_ms > head.received_at_ms
    : compareUtf8(event.id, head.id) > 0;

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
    // An UNCHANGED report is a launch: it counts and moves the head, but no
    // event list shows it, so no event row or outcome row keeps it.
    if (event.type !== "UNCHANGED") {
      tx.create("bundle_events", event);
      countOutcome(tx, event);
    }
    if (event.type === "UPDATE_FAILED") {
      countFailure(tx, event);
      return;
    }
    countEvent(tx, event);
    countExit(tx, event);
    if (previous !== null && !isNewer(event, previous)) return;
    if (previous === null) {
      tx.create("bundle_event_heads", event);
    } else {
      const { install_id: _, ...fields } = event;
      countHead(tx, previous, -1);
      tx.update("bundle_event_heads", previous, fields);
    }
    countHead(tx, event, 1);
  });
};
