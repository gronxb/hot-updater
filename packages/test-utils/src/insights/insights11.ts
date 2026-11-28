import {
  type AnyHotUpdaterPlugin,
  defineAggregate,
  definePlugin,
  defineTable,
} from "@hot-updater/plugin-core";
import type { BundleEventRow } from "@hot-updater/plugin-insights/server";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * The refs a 1.1 server wrote: each names the artifact. A frozen copy of
 * 1.1's `bundleRefsOf`, so the fixture writes rows as 1.1 did.
 */
const artifactRefsOf = (row: BundleEventRow): string[] => {
  const metadata = row.metadata as {
    readonly late?: true;
    readonly failure?: { readonly stage?: string };
    readonly change?: { readonly kinds?: readonly string[] };
  };
  if (metadata.late === true) return [];
  if (row.type === "UPDATE_FAILED" && metadata.failure?.stage === "check") {
    return [];
  }
  if (row.type === "RECOVERED") return [`from:${row.from_bundle_id}`];
  if (row.type === "UNCHANGED") {
    const kinds = metadata.change?.kinds ?? [];
    return kinds.includes("bundle") &&
      !kinds.includes("first_seen") &&
      row.to_release_id !== null
      ? [`on:${row.to_bundle_id}`]
      : [];
  }
  return [`to:${row.to_bundle_id}`];
};

/**
 * Insights' raw events and outcome counters as 1.1 declared them, which a
 * 1.1 server writes: the same tables, columns, and indexes, with refs that
 * name the artifact.
 */
const insights11Schema = {
  bundle_events: defineTable(
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
        day: {
          type: "integer",
          compute: (row) => row.received_at_ms - (row.received_at_ms % DAY),
        },
        movement_install_id: {
          type: "string",
          compute: (row) => row.install_id,
        },
        bundle_ref: {
          type: "string",
          multi: true,
          compute: (row) => artifactRefsOf(row as unknown as BundleEventRow),
        },
      },
      indexes: {
        movementsByInstall: {
          eq: ["movement_install_id"],
          sort: ["received_at_ms"],
        },
        byBundle: {
          eq: ["platform", "channel", "type", "bundle_ref", "day"],
          sort: ["received_at_ms"],
        },
        byDay: { eq: ["day"], sort: ["received_at_ms"] },
      },
      retention: { field: "day", days: 90 },
    },
  ),
  insights_outcomes: defineAggregate(
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
      batched: true,
      indexes: {
        byRef: {
          eq: ["platform", "channel", "type", "bundle_ref"],
          sort: ["bucket_start_ms"],
        },
      },
      retention: { field: "bucket_start_ms", days: 90 },
    },
  ),
} as const;

/**
 * A 1.1 server's `insights()` as far as the release-ref backfill reads it:
 * its API's `record(row)` stores an event and counts its outcome hours by
 * artifact, as 1.1's `countOutcome` did, to test the backfill and `db
 * migrate` on rows a 1.1 server wrote. It stands in for the official
 * plugin, so it takes its id and brand; serve it over a database whose
 * Insights tables `insights()` created.
 */
export const insights11TestPlugin = (): AnyHotUpdaterPlugin =>
  Object.defineProperty(
    definePlugin({
      id: "insights",
      namespace: false,
      schemaVersion: "1.0.0",
      schema: insights11Schema,
      init: ({ db }) => ({
        api: {
          record: (event: BundleEventRow) =>
            db.transaction(async (tx) => {
              tx.create("bundle_events", event as never);
              const hour = (type: string, ref: string) =>
                tx.aggregate(
                  "insights_outcomes",
                  {
                    platform: event.platform,
                    channel: event.channel,
                    type,
                    bundle_ref: ref,
                    bucket_start_ms:
                      event.received_at_ms - (event.received_at_ms % HOUR),
                  },
                  { events: 1 },
                  { shardBy: event.install_id },
                );
              for (const ref of artifactRefsOf(event)) hour(event.type, ref);
              if (
                (event.metadata as { implied_download?: true })
                  .implied_download === true
              ) {
                hour(
                  "UPDATE_DOWNLOADED",
                  `to:${event.type === "RECOVERED" ? event.from_bundle_id : event.to_bundle_id}`,
                );
              }
              tx.aggregate(
                "insights_outcomes",
                {
                  platform: "*",
                  channel: "",
                  type: "",
                  bundle_ref: "",
                  bucket_start_ms:
                    event.received_at_ms - (event.received_at_ms % DAY),
                },
                { events: 1 },
                { shardBy: event.install_id },
              );
            }),
        },
      }),
    }),
    Symbol.for("@hot-updater/server/official-plugin"),
    { value: true },
  );

/** What `insights11TestPlugin()` serves as `api.insights`. */
export type Insights11TestApi = {
  readonly record: (event: BundleEventRow) => Promise<void>;
};
