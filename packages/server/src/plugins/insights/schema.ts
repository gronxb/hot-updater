import { defineAggregate, defineTable } from "../../database/schema";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const MOVEMENTS = new Set(["UPDATE_DOWNLOADED", "UPDATE_APPLIED", "RECOVERED"]);

const bundleEvents = defineTable(
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
      /** `from:<bundle>` and `to:<bundle>`, read by bundle filters. */
      bundle_ref: {
        type: "string",
        multi: true,
        compute: (row) => [
          ...(row.from_bundle_id === null
            ? []
            : [`from:${row.from_bundle_id}`]),
          `to:${row.to_bundle_id}`,
        ],
      },
    },
    indexes: {
      recent: { eq: ["channel", "platform", "day"], sort: ["received_at_ms"] },
      movementsByInstall: {
        eq: ["movement_install_id"],
        sort: ["received_at_ms"],
      },
      byBundle: {
        eq: ["platform", "channel", "type", "bundle_ref", "day"],
        sort: ["received_at_ms"],
      },
    },
  },
);

/** Each installation's latest event. */
const bundleEventHeads = defineTable(
  {
    install_id: { type: "string", maxLength: 255 },
    id: { type: "string", maxLength: 36 },
    received_at_ms: { type: "integer" },
    user_id: { type: "string", maxLength: 255, required: false },
    platform: { type: "string", maxLength: 16 },
    channel: { type: "string" },
    type: { type: "string", maxLength: 32 },
    from_bundle_id: { type: "string", maxLength: 36, required: false },
    to_bundle_id: { type: "string", maxLength: 36 },
    current_release_id: { type: "string", maxLength: 36, required: false },
    app_version: { type: "string" },
  },
  {
    key: ["install_id"],
    indexes: { byUser: { eq: ["user_id"], sort: ["install_id"] } },
  },
);

/** Rows keyed by a hashed identity (scope and period) and a bucket. */
const identityFields = {
  identity: { type: "string", maxLength: 32 },
  bucket_start_ms: { type: "integer" },
} as const;
const window = { eq: ["identity"], sort: ["bucket_start_ms"] } as const;

const insightsOverview = defineAggregate(identityFields, {
  key: ["identity", "bucket_start_ms"],
  counters: ["downloads", "launches", "failed_launches"],
  shards: 8,
  indexes: { window },
});

const insightsSketches = defineAggregate(identityFields, {
  key: ["identity", "bucket_start_ms"],
  distinct: ["launch_users", "activity_users"],
  shards: 8,
  indexes: { window },
});

/** Installations counted in the hour of their latest event. */
const insightsDistribution = defineAggregate(
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
    shards: 8,
    indexes: {
      byScope: { eq: ["channel", "platform"], sort: ["bucket_start_ms"] },
      byVersion: {
        eq: ["channel", "platform", "app_version"],
        sort: ["bucket_start_ms"],
      },
    },
  },
);

/** Latest events by the bundle they came from or went to. */
const insightsLatestByBundle = defineAggregate(
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
    shards: 8,
    indexes: {
      byBundle: {
        eq: ["platform", "channel", "bundle_field", "bundle_id", "type"],
        sort: ["bucket_start_ms"],
      },
    },
  },
);

/** Events by outcome and the bundle a bundle filter matches. */
const insightsOutcomes = defineAggregate(
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
    shards: 8,
    indexes: {
      byRef: {
        eq: ["platform", "channel", "type", "bundle_ref"],
        sort: ["bucket_start_ms"],
      },
    },
  },
);

export const insightsSchema = {
  bundle_events: bundleEvents,
  bundle_event_heads: bundleEventHeads,
  insights_overview: insightsOverview,
  insights_sketches: insightsSketches,
  insights_distribution: insightsDistribution,
  insights_latest_by_bundle: insightsLatestByBundle,
  insights_outcomes: insightsOutcomes,
} as const;

export type InsightsSchema = typeof insightsSchema;
