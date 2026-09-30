import { defineAggregate, defineTable } from "../../database/schema";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** How long Insights keeps its rows, in whole days. Lifetime counters are kept. */
export interface InsightsRetention {
  /** Raw events and hourly rollups. */
  readonly rawDays: number;
  /** Daily rollups, and each installation's latest event and the gauges that count it. */
  readonly dailyDays: number;
}

/**
 * The default periods (decision 59): 90 days, and 13 months as 400 days, so
 * the same month a year ago stays whole.
 */
export const RAW_RETENTION_DAYS = 90;
export const DAILY_RETENTION_DAYS = 400;
export const DEFAULT_INSIGHTS_RETENTION: InsightsRetention = {
  rawDays: RAW_RETENTION_DAYS,
  dailyDays: DAILY_RETENTION_DAYS,
};

/** Rows keyed by a bucket that expire `days` after it starts. */
interface BucketRetention {
  readonly field: "bucket_start_ms";
  readonly days: number;
}
const bucketRetention = (days: number): BucketRetention => ({
  field: "bucket_start_ms",
  days,
});

const MOVEMENTS = new Set(["UPDATE_DOWNLOADED", "UPDATE_APPLIED", "RECOVERED"]);

/**
 * Downloads, applies, and recoveries, whole. An UNCHANGED report counts as a
 * launch and moves its installation's head, but no list shows it, so no row
 * keeps it.
 */
const bundleEvents = (days: number) =>
  defineTable(
    {
      id: { type: "string", maxLength: 36 },
      type: { type: "string", maxLength: 32 },
      install_id: { type: "string", maxLength: 255 },
      user_id: { type: "string", maxLength: 255, required: false },
      from_release_id: { type: "string", maxLength: 36, required: false },
      from_bundle_id: { type: "string", maxLength: 36, required: false },
      to_release_id: { type: "string", maxLength: 36, required: false },
      to_bundle_id: { type: "string", maxLength: 36 },
      platform: { type: "string", maxLength: 16 },
      app_version: { type: "string" },
      channel: { type: "string" },
      metadata: { type: "json" },
      received_at_ms: { type: "integer" },
    },
    {
      key: ["id"],
      derived: {
        /** The UTC day the event was received in. */
        day: {
          type: "integer",
          compute: (row) => row.received_at_ms - (row.received_at_ms % DAY_MS),
        },
        /** Set only for events that belong in installation history. */
        movement_install_id: {
          type: "string",
          compute: (row) => (MOVEMENTS.has(row.type) ? row.install_id : null),
        },
        /** The bundle a bundle filter matches: `from:<bundle>` for RECOVERED, else `to:<bundle>`. */
        bundle_ref: {
          type: "string",
          multi: true,
          compute: (row) => [
            row.type === "RECOVERED" && row.from_bundle_id !== null
              ? `from:${row.from_bundle_id}`
              : `to:${row.to_bundle_id}`,
          ],
        },
      },
      indexes: {
        recent: {
          eq: ["channel", "platform", "day"],
          sort: ["received_at_ms"],
        },
        movementsByInstall: {
          eq: ["movement_install_id"],
          sort: ["received_at_ms"],
        },
        byBundle: {
          eq: ["platform", "channel", "type", "bundle_ref", "day"],
          sort: ["received_at_ms"],
        },
        /** Events of every scope by day, for the console's unfiltered event list. */
        byDay: { eq: ["day"], sort: ["received_at_ms"] },
      },
      // A day's events go together, oldest days first, walking `byDay`.
      retention: { field: "day", days },
    },
  );

/**
 * Each installation's latest event, whole, so reading it is one point read.
 * `current_release_id` says where its gauges count it (`COUNTED_BY_DAY`).
 */
const bundleEventHeads = (days: number) =>
  defineTable(
    {
      install_id: { type: "string", maxLength: 255 },
      id: { type: "string", maxLength: 36 },
      type: { type: "string", maxLength: 32 },
      user_id: { type: "string", maxLength: 255, required: false },
      from_release_id: { type: "string", maxLength: 36, required: false },
      from_bundle_id: { type: "string", maxLength: 36, required: false },
      to_release_id: { type: "string", maxLength: 36, required: false },
      to_bundle_id: { type: "string", maxLength: 36 },
      platform: { type: "string", maxLength: 16 },
      app_version: { type: "string" },
      channel: { type: "string" },
      metadata: { type: "json" },
      received_at_ms: { type: "integer" },
      current_release_id: { type: "string", maxLength: 36, required: false },
    },
    {
      key: ["install_id"],
      indexes: { byUser: { eq: ["user_id"], sort: ["install_id"] } },
      // An installation unseen for the daily period is gone, with its gauges' day.
      retention: { field: "received_at_ms", days },
    },
  );

/**
 * Shards are keyed by install id. Counters are blind increments and never
 * conflict, so they keep 8. Gauges and sketches are read, merged, and written
 * back. B3's rollout gate on PostgreSQL retried 2.4% of transactions at 8
 * shards and 1.3% at 16. DynamoDB's transactions take longer, so D8's gate
 * on DynamoDB Local retried 2–24% at 16, almost all on gauge rows, and 1–5%
 * with gauges at 32. Sketches stay at 16: each shard row carries 2 KB of
 * registers that every read merges.
 *
 * Every Insights aggregate is `batched`: on DynamoDB and Firestore, which
 * bill each write, an event's changes apply after it commits, merged with
 * other events' into one write per row, on one shard per writer.
 */
const COUNTER_SHARDS = 8;
const GAUGE_SHARDS = 32;
const SKETCH_SHARDS = 16;

/** Rows keyed by a hashed identity (scope and period) and a bucket. */
const identityFields = {
  identity: { type: "string", maxLength: 32 },
  bucket_start_ms: { type: "integer" },
} as const;
const window = { eq: ["identity"], sort: ["bucket_start_ms"] } as const;

/** Counters of one period kind: hourly, daily, or lifetime at bucket 0. */
const counters = (retention?: BucketRetention) =>
  defineAggregate(identityFields, {
    key: ["identity", "bucket_start_ms"],
    counters: ["downloads", "launches", "failed_launches"],
    shards: COUNTER_SHARDS,
    batched: true,
    indexes: { window },
    ...(retention === undefined ? {} : { retention }),
  });

/** Unique-installation sketches of one period kind. */
const sketches = (retention: BucketRetention) =>
  defineAggregate(identityFields, {
    key: ["identity", "bucket_start_ms"],
    distinct: ["launch_users", "activity_users"],
    shards: SKETCH_SHARDS,
    batched: true,
    indexes: { window },
    retention,
  });

/**
 * Installations counted in the UTC day of their latest event; heads recorded
 * while gauges counted hours stay in the hour of theirs until they move.
 * Either lies inside the event's UTC day, so reads sum whole UTC days.
 */
const insightsDistribution = (retention: BucketRetention) =>
  defineAggregate(
    {
      channel: { type: "string" },
      platform: { type: "string", maxLength: 16 },
      app_version: { type: "string" },
      release_id: { type: "string", maxLength: 36 },
      bucket_start_ms: { type: "integer" },
    },
    {
      key: [
        "channel",
        "platform",
        "app_version",
        "release_id",
        "bucket_start_ms",
      ],
      gauges: ["latest_installations"],
      shards: GAUGE_SHARDS,
      batched: true,
      indexes: {
        byScope: { eq: ["channel", "platform"], sort: ["bucket_start_ms"] },
        byVersion: {
          eq: ["channel", "platform", "app_version"],
          sort: ["bucket_start_ms"],
        },
      },
      retention,
    },
  );

/** Latest events by the bundle they came from or went to, bucketed like the distribution. */
const insightsLatestByBundle = (retention: BucketRetention) =>
  defineAggregate(
    {
      platform: { type: "string", maxLength: 16 },
      channel: { type: "string" },
      bundle_field: { type: "string", maxLength: 16 },
      bundle_id: { type: "string", maxLength: 36 },
      type: { type: "string", maxLength: 32 },
      bucket_start_ms: { type: "integer" },
    },
    {
      key: [
        "platform",
        "channel",
        "bundle_field",
        "bundle_id",
        "type",
        "bucket_start_ms",
      ],
      gauges: ["installations"],
      shards: GAUGE_SHARDS,
      batched: true,
      indexes: {
        byBundle: {
          eq: ["platform", "channel", "bundle_field", "bundle_id", "type"],
          sort: ["bucket_start_ms"],
        },
      },
      retention,
    },
  );

/**
 * Stored events by outcome and the bundle a bundle filter matches, a row an
 * hour; and every stored event, a row a UTC day (`DAILY_EVENTS`). Bundle
 * counts sum the hourly rows, and event lists read either to skip days
 * without events.
 */
const insightsOutcomes = (retention: BucketRetention) =>
  defineAggregate(
    {
      platform: { type: "string", maxLength: 16 },
      channel: { type: "string" },
      type: { type: "string", maxLength: 32 },
      bundle_ref: { type: "string", maxLength: 41 },
      bucket_start_ms: { type: "integer" },
    },
    {
      key: ["platform", "channel", "type", "bundle_ref", "bucket_start_ms"],
      counters: ["events"],
      shards: COUNTER_SHARDS,
      batched: true,
      indexes: {
        byRef: {
          eq: ["platform", "channel", "type", "bundle_ref"],
          sort: ["bucket_start_ms"],
        },
      },
      // The per-day rows too: they count raw events, which keep the raw period.
      retention,
    },
  );

/**
 * The `insights_outcomes` identity that counts every stored event, for the
 * global event list. Its bucket is a UTC day, not an hour. Every event's
 * platform is ios or android, so no outcome row of a bundle filter shares it.
 */
export const DAILY_EVENTS = {
  platform: "*",
  channel: "",
  type: "",
  bundle_ref: "",
} as const;

/**
 * Insights' tables, each expiring after its period. The periods are values
 * the engine applies at runtime; the tables and indexes are the same for
 * any periods.
 */
export const createInsightsSchema = ({
  rawDays,
  dailyDays,
}: InsightsRetention = DEFAULT_INSIGHTS_RETENTION) => {
  const hourly = bucketRetention(rawDays);
  const daily = bucketRetention(dailyDays);
  return {
    bundle_events: bundleEvents(rawDays),
    bundle_event_heads: bundleEventHeads(dailyDays),
    /** Hourly counters and sketches: the raw period. */
    insights_overview: counters(hourly),
    insights_sketches: sketches(hourly),
    /** Daily counters and sketches: the daily period. */
    insights_overview_daily: counters(daily),
    insights_sketches_daily: sketches(daily),
    /** A release's counters since its first event: kept. */
    insights_overview_lifetime: counters(),
    insights_distribution: insightsDistribution(daily),
    insights_latest_by_bundle: insightsLatestByBundle(daily),
    insights_outcomes: insightsOutcomes(hourly),
  } as const;
};

export const insightsSchema = createInsightsSchema();

export type InsightsSchema = typeof insightsSchema;
