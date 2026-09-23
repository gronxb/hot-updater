import type { BundleEventRow } from "@hot-updater/plugin-core";
import {
  addInsightsDistinct,
  assertBundleEventRow,
  compareUtf8,
  currentInsightsReleaseId,
  insightsOverviewDeltas,
  insightsOverviewId,
  type InsightsOverviewIdentity,
} from "@hot-updater/plugin-core/internal";

import type {
  HotUpdaterDatabase,
  HotUpdaterTransaction,
} from "../../database/database";
import { DAY_MS, HOUR_MS, type InsightsSchema } from "./schema";

/** The head columns `countHead` reads. */
interface Head {
  readonly install_id: string;
  readonly id: string;
  readonly received_at_ms: number;
  readonly platform: string;
  readonly channel: string;
  readonly type: string;
  readonly from_bundle_id: string | null;
  readonly to_bundle_id: string;
  readonly current_release_id: string | null;
  readonly app_version: string;
}

const hourOf = (ms: number) => ms - (ms % HOUR_MS);

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

/** The head columns besides its key: the whole event and its current release. */
const headFields = (event: BundleEventRow) => {
  const { install_id: _, ...fields } = event;
  return { ...fields, current_release_id: currentInsightsReleaseId(event) };
};

/** Moves a head's gauges: the distribution row and one row per bundle it references. */
const countHead = (
  tx: HotUpdaterTransaction<InsightsSchema>,
  head: Head,
  delta: 1 | -1,
) => {
  const bucket = hourOf(head.received_at_ms);
  const shardBy = head.install_id;
  tx.aggregate(
    "insights_distribution",
    {
      channel: head.channel,
      platform: head.platform,
      app_version: head.app_version,
      release_id: head.current_release_id ?? "",
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
};

/** Counters and sketches for one event: release, channel, and usage rows, with day rollups for channel and usage. */
const countEvent = (
  tx: HotUpdaterTransaction<InsightsSchema>,
  event: BundleEventRow,
) => {
  const shardBy = event.install_id;
  for (const delta of insightsOverviewDeltas(event)) {
    const { bucketStartMs, ...parts } = delta.identity;
    const periods =
      parts.scopeKind === "channel" || parts.scopeKind === "usage"
        ? ([
            ["hour", bucketStartMs],
            ["day", event.received_at_ms - (event.received_at_ms % DAY_MS)],
          ] as const)
        : ([[parts.periodKind, bucketStartMs]] as const);
    for (const [periodKind, bucket] of periods) {
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
        tx.aggregate("insights_overview", key, counters, { shardBy });
      }
      const sketches = {
        ...(delta.launchIdentity === undefined
          ? {}
          : { launch_users: addInsightsDistinct(null, delta.launchIdentity) }),
        ...(delta.activityIdentity === undefined
          ? {}
          : {
              activity_users: addInsightsDistinct(null, delta.activityIdentity),
            }),
      };
      if (Object.keys(sketches).length > 0) {
        tx.aggregate("insights_sketches", key, sketches, { shardBy });
      }
    }
  }
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
};

const isNewer = (event: Head, head: Head) =>
  event.received_at_ms !== head.received_at_ms
    ? event.received_at_ms > head.received_at_ms
    : compareUtf8(event.id, head.id) > 0;

/**
 * Records one event in one transaction: one batch read of the event and its
 * installation's head, one of the gauge and sketch rows it changes, then one
 * write. A repeated id changes nothing; an older event still counts in its own
 * hour but never replaces the head.
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
    if (existing !== null) return;
    tx.create("bundle_events", event);
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
