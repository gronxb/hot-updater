import type { HotUpdaterDatabase } from "../../database/database";
import { countHead } from "./recordEvent";
import type { InsightsSchema } from "./schema";

type Db = HotUpdaterDatabase<InsightsSchema>;

/**
 * What one deletion call removed. A call deletes a bounded batch, so
 * `complete` is false while rows remain and the caller asks again.
 */
export interface InsightsDeletion {
  readonly deleted: {
    readonly installations: number;
    readonly events: number;
  };
  readonly complete: boolean;
}

export interface InsightsDeletionOptions {
  /** The most rows (events and installations) one call deletes; 500 by default. */
  readonly limit?: number;
}

/**
 * Events one transaction deletes. On a key-value store an event is its row
 * and four index items, so 16 of them stay within DynamoDB's 100 a write.
 */
const EVENTS_PER_WRITE = 16;
const DEFAULT_LIMIT = 500;

const movements = (db: Db, installId: string, limit: number) =>
  db.findMany("bundle_events", {
    index: "movementsByInstall",
    where: { movement_install_id: installId },
    limit,
  });

/**
 * Deletes one installation's Insights data: its raw events, which
 * `movementsByInstall` finds since only movements are stored, then its
 * latest event, taking back the gauges that count it. Counters and sketches
 * hold no identifier (sketch registers hold hashes), so they stay and age
 * out with retention. An installation that reports again records again.
 */
export const deleteInstallation = async (
  db: Db,
  installId: string,
  { limit = DEFAULT_LIMIT }: InsightsDeletionOptions = {},
): Promise<InsightsDeletion> => {
  let events = 0;
  while (events < limit) {
    const page = await movements(
      db,
      installId,
      Math.min(EVENTS_PER_WRITE, limit - events),
    );
    if (page.rows.length === 0) break;
    await db.transaction(async (tx) => {
      for (const { id } of page.rows) {
        const event = await tx.findOne("bundle_events", { id });
        if (event !== null) await tx.delete("bundle_events", event);
      }
    });
    events += page.rows.length;
  }
  const done = (installations: number, complete: boolean) => ({
    deleted: { installations, events },
    complete,
  });
  if (events >= limit || (await movements(db, installId, 1)).rows.length > 0) {
    return done(0, false);
  }
  const installations = await db.transaction(async (tx) => {
    const head = await tx.findOne("bundle_event_heads", {
      install_id: installId,
    });
    if (head === null) return 0;
    countHead(tx, head, -1);
    await tx.delete("bundle_event_heads", head);
    return 1;
  });
  return done(installations, true);
};

/**
 * Deletes the Insights data of every installation whose latest event names
 * the user, one installation after another through `byUser`. Events an
 * installation sent under the user before another user signed in on it are
 * not found this way; they age out with retention.
 */
export const deleteUser = async (
  db: Db,
  userId: string,
  { limit = DEFAULT_LIMIT }: InsightsDeletionOptions = {},
): Promise<InsightsDeletion> => {
  const deleted = { installations: 0, events: 0 };
  const next = async () =>
    (
      await db.findMany("bundle_event_heads", {
        index: "byUser",
        where: { user_id: userId },
        limit: 1,
      })
    ).rows[0];
  for (let head = await next(); head !== undefined; head = await next()) {
    const spent = deleted.installations + deleted.events;
    if (spent >= limit) return { deleted, complete: false };
    const step = await deleteInstallation(db, head.install_id, {
      limit: limit - spent,
    });
    deleted.installations += step.deleted.installations;
    deleted.events += step.deleted.events;
    if (!step.complete) return { deleted, complete: false };
  }
  return { deleted, complete: true };
};
