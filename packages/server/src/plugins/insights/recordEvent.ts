import type { BundleEventRow } from "@hot-updater/plugin-core";
import {
  addInsightsDistinct,
  assertBundleEventRow,
  compareUtf8,
  insightsKey,
  insightsOverviewDeltas,
  insightsOverviewId,
  type InsightsOverviewIdentity,
} from "@hot-updater/plugin-core/internal";

import type {
  HotUpdaterDatabase,
  HotUpdaterTransaction,
} from "../../database/database";
import { DAILY_EVENTS, DAY_MS, HOUR_MS, type InsightsSchema } from "./schema";

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
  readonly current_release_id: string | null;
  readonly app_version: string;
}

const hourOf = (ms: number) => ms - (ms % HOUR_MS);
const dayOf = (ms: number) => ms - (ms % DAY_MS);

/** An overview or sketch row's scope and period; day periods roll up channel and usage rows. */
export type InsightsIdentityParts = Omit<
  InsightsOverviewIdentity,
  "bucketStartMs" | "periodKind"
> & { readonly periodKind: InsightsOverviewIdentity["periodKind"] | "day" };

/** The `identity` of an overview or sketch row: its scope and period, hashed. */
export const insightsIdentity = (identity: InsightsIdentityParts): string =>
  insightsOverviewId({
    ...identity,
    periodKind: identity.periodKind as InsightsOverviewIdentity["periodKind"],
    bucketStartMs: 0,
  });

/**
 * The `current_release_id` of a head whose gauges count it in the UTC day of
 * its event. A head recorded while gauges counted hours holds its current
 * release there instead, and stays counted in the hour of its event until it
 * moves. Both lie inside the event's UTC day, which is what reads sum.
 */
export const COUNTED_BY_DAY = "day";

/** The head columns besides its key: the whole event, counted by day. */
const headFields = (event: BundleEventRow) => {
  const { install_id: _, ...fields } = event;
  return { ...fields, current_release_id: COUNTED_BY_DAY };
};

/**
 * The bucket a head's gauges count it in, and the release its distribution
 * row names: the one it runs, which a download leaves at its source.
 */
const gaugeSlot = (head: Head) =>
  head.current_release_id === COUNTED_BY_DAY
    ? {
        bucket: dayOf(head.received_at_ms),
        releaseId:
          head.type === "UPDATE_DOWNLOADED"
            ? head.from_release_id
            : head.to_release_id,
      }
    : {
        bucket: hourOf(head.received_at_ms),
        releaseId: head.current_release_id,
      };

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
 * references, and its pair. Deleting an installation takes it back with -1.
 */
export const countHead = (
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

/**
 * Counters and sketches for one event: release, channel, and usage rows, with
 * day rollups for channel and usage. Usage rows are written for the event's
 * platform only, since a read for every platform merges the ios and android
 * sketches; a channel's active installations come from its usage rows, so
 * channel rows keep no sketch of their own.
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
      } = Object.fromEntries(
        [
          ["downloads", delta.downloads],
          ["launches", delta.launches],
          ["failed_launches", delta.failedLaunches],
        ].filter(([, value]) => value !== 0),
      );
      if (Object.keys(counters).length > 0) {
        tx.aggregate(models.counters, key, counters, { shardBy });
      }
      const sketches = {
        ...(delta.launchIdentity === undefined || parts.scopeKind === "channel"
          ? {}
          : { launch_users: addInsightsDistinct(null, delta.launchIdentity) }),
        ...(delta.activityIdentity === undefined
          ? {}
          : {
              activity_users: addInsightsDistinct(null, delta.activityIdentity),
            }),
      };
      if (models.sketches !== undefined && Object.keys(sketches).length > 0) {
        tx.aggregate(models.sketches, key, sketches, { shardBy });
      }
    }
  }
};

/**
 * A stored event's outcome rows: its bundle filter's hour, and every stored
 * event's UTC day.
 */
const countOutcome = (
  tx: HotUpdaterTransaction<InsightsSchema>,
  event: BundleEventRow,
) => {
  const shardBy = event.install_id;
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
 * own hour but never replaces the head.
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
    countEvent(tx, event);
    const fields = headFields(event);
    const head = { ...fields, install_id: event.install_id };
    if (previous !== null && !isNewer(head, previous)) return;
    if (previous === null) {
      tx.create("bundle_event_heads", head);
    } else {
      countHead(tx, previous, -1);
      tx.update("bundle_event_heads", previous, fields);
    }
    countHead(tx, head, 1);
  });
};
