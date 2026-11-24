import {
  DatabaseConstraintError,
  type HotUpdaterDatabase,
} from "@hot-updater/plugin-core";

import {
  bundleRefsOf,
  type BundleRefKey,
  DAY_MS,
  HOUR_MS,
  type InsightsRetention,
  type InsightsSchema,
  outcomeRefsOf,
} from "./schema";

/** What `backfillReleaseRefs` moved, or with `dryRun` would move. */
export interface ReleaseRefBackfill {
  /** Stored events whose refs moved from their artifact to their release. */
  readonly events: number;
}

/**
 * Stored events read a page, and rewritten up to `BATCH` a transaction. A
 * store that takes fewer physical writes a transaction, as DynamoDB's 100
 * items hold fewer than 25 rewrites with their index copies and counts,
 * refuses the batch before writing anything; it is then rewritten in halves.
 */
const PAGE = 500;
const BATCH = 25;

type StoredEvent = Parameters<typeof bundleRefsOf>[0] & {
  readonly id: string;
  readonly install_id: string;
  readonly platform: string;
  readonly channel: string;
  readonly received_at_ms: number;
  readonly bundle_ref?: unknown;
};

const sameRefs = (stored: unknown, refs: readonly string[]): boolean => {
  const values = Array.isArray(stored) ? (stored as string[]) : [];
  return (
    values.length === refs.length &&
    values.every((value) => refs.includes(value))
  );
};

/**
 * Whether a stored event still names its artifact, as a 1.1 server wrote
 * it: its stored refs are the artifact's and differ from the release's. Its
 * stored refs are how its outcome rows counted it, so they are what a
 * rewrite moves, and a rewritten event reads as done.
 */
const namesArtifact = (row: StoredEvent): boolean => {
  const byKey = (key: BundleRefKey) => bundleRefsOf(row, key);
  return (
    sameRefs(row.bundle_ref, byKey("artifact")) &&
    !sameRefs(row.bundle_ref, byKey("release"))
  );
};

/**
 * Rewrites the stored events in the raw period whose refs name their
 * artifact, as 1.1 servers wrote them, to name their release, and moves
 * their hourly outcome counts with them, each event in the transaction that
 * rewrites it. Each event carries its own release IDs, so two releases of
 * one artifact in one scope come apart; an event without a release ID keeps
 * the bundle ID it reports, as new events do.
 *
 * It reads every stored event once and writes only those still to move, so
 * an interrupted run can run again. `hot-updater db migrate` and `hot-updater
 * init` run it once a database: when it completes they record the settings
 * row `insights.releaseRefs`, and later runs read no event. Installation
 * gauges need nothing: they name releases already.
 */
export const backfillReleaseRefs = async (
  db: HotUpdaterDatabase<InsightsSchema>,
  now: () => number,
  { rawDays }: InsightsRetention,
  { dryRun = false }: { readonly dryRun?: boolean } = {},
): Promise<ReleaseRefBackfill> => {
  const today = now() - (now() % DAY_MS);
  let events = 0;
  const move = async (candidates: readonly StoredEvent[]): Promise<void> => {
    if (dryRun) {
      events += candidates.length;
      return;
    }
    // Read before adding: a split adds its halves' events meanwhile.
    const moved = await rewrite(candidates).catch(async (error: unknown) => {
      if (
        !(error instanceof DatabaseConstraintError) ||
        error.reason !== "too_large" ||
        candidates.length === 1
      ) {
        throw error;
      }
      const half = Math.ceil(candidates.length / 2);
      await move(candidates.slice(0, half));
      await move(candidates.slice(half));
      return 0;
    });
    events += moved;
  };
  const rewrite = (candidates: readonly StoredEvent[]) =>
    db.transaction(async (tx) => {
      const rows = await Promise.all(
        candidates.map(({ id }) => tx.findOne("bundle_events", { id })),
      );
      let moved = 0;
      for (const row of rows as (StoredEvent | null)[]) {
        // Another run rewrote it meanwhile.
        if (row === null || !namesArtifact(row)) continue;
        // The derived refs follow the event's own release IDs.
        tx.update("bundle_events", row as never, {});
        const outcome = (ref: readonly [string, string], delta: 1 | -1) =>
          tx.aggregate(
            "insights_outcomes",
            {
              platform: row.platform,
              channel: row.channel,
              type: ref[0],
              bundle_ref: ref[1],
              bucket_start_ms:
                row.received_at_ms - (row.received_at_ms % HOUR_MS),
            },
            { events: delta },
            { shardBy: row.install_id },
          );
        for (const ref of outcomeRefsOf(row, "artifact")) outcome(ref, -1);
        for (const ref of outcomeRefsOf(row, "release")) outcome(ref, 1);
        moved += 1;
      }
      return moved;
    });
  // Oldest day first; days past the raw period hold no events.
  for (let day = today - rawDays * DAY_MS; day <= today; day += DAY_MS) {
    let cursor: string | undefined;
    do {
      const page = await db.findMany("bundle_events", {
        index: "byDay",
        where: { day },
        limit: PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const stale = (page.rows as unknown as StoredEvent[]).filter(
        namesArtifact,
      );
      for (let start = 0; start < stale.length; start += BATCH) {
        await move(stale.slice(start, start + BATCH));
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return { events };
};
