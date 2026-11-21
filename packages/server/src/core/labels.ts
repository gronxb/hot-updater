import {
  DatabaseConstraintError,
  type Platform,
  type ReleaseRow,
} from "@hot-updater/plugin-core";

import { toReleaseRow, type CoreDatabase } from "./reads";
import type { CoreTransaction } from "./writes";

/**
 * The counter of a channel and platform's release labels: one
 * `label_sequences` row, which every writer of the pair reads and bumps.
 */
export const labelSequenceId = (channelId: string, platform: Platform) =>
  `releases/${platform}/${channelId}`;

/** The pairs a channel's counters belong to, which deleting it removes. */
export const LABEL_PLATFORMS: readonly Platform[] = ["ios", "android"];

/**
 * A channel and platform whose releases written before labels have none
 * yet, or that has no counter: the write stops before taking a label, the
 * core labels the pair with `fillLabels`, and the write runs again.
 */
export class NeedsLabelFill extends Error {
  constructor(
    readonly channelId: string,
    readonly platform: Platform,
  ) {
    super(`Release labels of ${platform} ${channelId} need a fill first.`);
  }
}

interface Pair {
  readonly channelId: string;
  readonly platform: Platform;
}

/** A pair whose counter a write read, at the value it read. */
interface UsedPair extends Pair {
  readonly read: number;
}

/**
 * Labels taken inside one transaction: each pair's counter is read once,
 * guarded, and written once by `flush`, so a batch that takes several labels
 * of one pair writes its counter one time, and a concurrent writer's commit
 * reruns this one.
 */
export interface LabelAllocator {
  next(channelId: string, platform: Platform): Promise<number>;
  /** Records a pair whose unlabeled releases this transaction labels. */
  caughtUp(channelId: string, platform: Platform): void;
  flush(): void;
}

const createLabelAllocator = (
  tx: CoreTransaction,
  used: Map<string, UsedPair>,
  caughtUp: Map<string, Pair>,
): LabelAllocator => {
  const sequences = new Map<
    string,
    {
      /** The counter as read, or null for one this transaction creates. */
      readonly row: Awaited<ReturnType<typeof tx.findOne<"label_sequences">>>;
      readonly read: number;
      last: number;
    }
  >();
  return {
    async next(channelId, platform) {
      const id = labelSequenceId(channelId, platform);
      let sequence = sequences.get(id);
      if (sequence === undefined) {
        const row = await tx.findOne("label_sequences", { id });
        if (row === null || !row.is_filled) {
          // A channel without releases, such as a new one, has none to
          // fill: its counter starts here, without a fill's write first.
          // Its row's release counter is read guarded, so a release written
          // in the channel meanwhile reruns this.
          const channel =
            row === null
              ? await tx.findOne("channels", { id: channelId })
              : null;
          if (
            channel === null ||
            (channel._refs_releases_channel_id ?? 0) > 0
          ) {
            throw new NeedsLabelFill(channelId, platform);
          }
        }
        const read = row?.last_label ?? 0;
        sequence = { row, read, last: read };
        sequences.set(id, sequence);
        used.set(id, { channelId, platform, read });
      }
      sequence.last += 1;
      return sequence.last;
    },
    caughtUp(channelId, platform) {
      caughtUp.set(labelSequenceId(channelId, platform), {
        channelId,
        platform,
      });
    },
    flush() {
      for (const [id, { row, read, last }] of sequences) {
        if (row === null) {
          tx.create("label_sequences", {
            id,
            last_label: last,
            is_filled: true,
          });
        } else if (last !== read) {
          tx.update("label_sequences", row, { last_label: last });
        }
      }
    },
  };
};

// The rows one fill transaction labels at first; a store that refuses that
// many in one write takes half as many, down to one.
const FILL_BATCH = 25;
const PAGE = 500;

/**
 * Labels a channel and platform's releases that have none, in ID order,
 * which is the order they were created in, and marks its counter filled:
 * each batch reads the counter and its rows guarded, so a concurrent fill or
 * write serializes on the counter and skips what another labeled. With
 * `dryRun`, it only counts them. Answers how many it labeled.
 */
export const fillLabels = async (
  db: CoreDatabase,
  { channelId, platform }: Pair,
  { dryRun = false }: { readonly dryRun?: boolean } = {},
): Promise<number> => {
  const id = labelSequenceId(channelId, platform);
  let labeled = 0;
  let batchSize = FILL_BATCH;
  const label = async (ids: readonly string[]) => {
    for (let at = 0; at < ids.length; ) {
      const batch = ids.slice(at, at + batchSize);
      try {
        labeled += await db.transaction(async (tx) => {
          const counter = await tx.findOne("label_sequences", { id });
          let last = counter?.last_label ?? 0;
          let count = 0;
          for (const releaseId of batch) {
            const row = await tx.findOne("releases", { id: releaseId });
            if (row === null || typeof row.label === "number") continue;
            last += 1;
            count += 1;
            tx.update("releases", row, { label: last });
          }
          if (counter === null) {
            tx.create("label_sequences", {
              id,
              last_label: last,
              is_filled: false,
            });
          } else if (last !== counter.last_label) {
            tx.update("label_sequences", counter, { last_label: last });
          }
          return count;
        });
        at += batch.length;
      } catch (error) {
        if (
          batchSize > 1 &&
          error instanceof DatabaseConstraintError &&
          error.reason === "too_large"
        ) {
          batchSize = Math.max(1, Math.floor(batchSize / 2));
          continue;
        }
        throw error;
      }
    }
  };
  let cursor: string | undefined;
  do {
    const page = await db.findMany("releases", {
      index: "byChannelPlatform",
      where: { channel_id: channelId, platform },
      limit: PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    // oxlint-disable-next-line hot-updater/no-filtered-find-many -- the fill reads each release of a pair that has some without a label once, in ID order, which it labels them in; no index selects a row without a label, which holds no `byLabel` entry
    const unlabeled = page.rows
      // A release an earlier server wrote may hold no label field at all.
      .filter((row) => typeof row.label !== "number")
      .map((row) => row.id);
    if (dryRun) labeled += unlabeled.length;
    else await label(unlabeled);
    cursor = page.next;
  } while (cursor !== undefined);
  if (dryRun) return labeled;
  await db.transaction(async (tx) => {
    const counter = await tx.findOne("label_sequences", { id });
    if (counter === null) {
      tx.create("label_sequences", { id, last_label: 0, is_filled: true });
    } else if (!counter.is_filled) {
      tx.update("label_sequences", counter, { is_filled: true });
    }
  });
  return labeled;
};

/**
 * Reads what a pair's fill writes, its counter and its label index, without
 * writing: a database without release labels' schema, such as one a 1.2
 * prerelease migrated, fails here as the fill would. The schema is the
 * database's, so one pair tells. Two reads.
 */
export const probeLabelSchema = async (
  db: CoreDatabase,
  { channelId, platform }: Pair,
): Promise<void> => {
  await db.findOne("label_sequences", {
    id: labelSequenceId(channelId, platform),
  });
  // Labels start at 1, so this reads the column and finds no row.
  await db.findMany("releases", {
    index: "byLabel",
    where: { channel_id: channelId, platform, label: 0 },
    limit: 1,
  });
};

// How many times a write repairs what a repair should have settled, a pair
// it already filled or a held label, before it fails, and how many races
// with another writer's label it reruns after. A pair's first fill spends
// neither: it is progress, at most once per pair the write labels, so a
// batch over any number of channels and platforms fills each and runs.
const REPAIRS = 4;
const RACES = 32;

/**
 * Runs a release write that takes labels, in one transaction with the
 * counters it bumps. A pair that still needs its fill is filled, and the
 * write runs again; so is a pair whose catch-up made the write too large for
 * the store. A label another row holds, such as an index item a release
 * deleted by a server of an earlier release left on a key-value store, is
 * skipped: its counters move past it and the write runs again.
 */
export const writeWithLabels = async <T>(
  db: CoreDatabase,
  write: (tx: CoreTransaction, labels: LabelAllocator) => Promise<T>,
): Promise<T> => {
  // The pairs this write filled: each fills once for free, and only the
  // pairs the write labels can join, so the free fills are bounded by them.
  const filled = new Set<string>();
  const fill = async (pairs: readonly Pair[]) => {
    for (const pair of pairs) {
      filled.add(labelSequenceId(pair.channelId, pair.platform));
      await fillLabels(db, pair);
    }
  };
  for (let repairs = 0, races = 0; ; ) {
    const used = new Map<string, UsedPair>();
    const caughtUp = new Map<string, Pair>();
    try {
      return await db.transaction(async (tx) => {
        used.clear();
        caughtUp.clear();
        const labels = createLabelAllocator(tx, used, caughtUp);
        const result = await write(tx, labels);
        labels.flush();
        return result;
      });
    } catch (error) {
      const needs =
        error instanceof NeedsLabelFill
          ? [error]
          : error instanceof DatabaseConstraintError &&
              error.reason === "too_large"
            ? [...caughtUp.values()]
            : [];
      if (needs.length > 0) {
        const fresh = needs.some(
          ({ channelId, platform }) =>
            !filled.has(labelSequenceId(channelId, platform)),
        );
        if (fresh || repairs < REPAIRS) {
          if (!fresh) repairs += 1;
          await fill(needs);
          continue;
        }
      }
      if (
        error instanceof DatabaseConstraintError &&
        error.reason === "unique" &&
        error.model === "releases" &&
        used.size > 0
      ) {
        // A writer that took the label first moved its counter: run again
        // from it. A counter that stayed means a row this write can't see
        // holds the label: move past it.
        const held = await db.transaction(async (tx) => {
          const moves: (() => void)[] = [];
          for (const [id, { channelId, read }] of used) {
            const counter = await tx.findOne("label_sequences", { id });
            if (counter !== null) {
              if (counter.last_label !== read) return false;
              moves.push(() =>
                tx.update("label_sequences", counter, {
                  last_label: read + 1,
                }),
              );
              continue;
            }
            // A counter the write was to create: still none, and still no
            // release in the channel.
            const channel = await tx.findOne("channels", { id: channelId });
            if (
              channel === null ||
              (channel._refs_releases_channel_id ?? 0) > 0
            ) {
              return false;
            }
            moves.push(() =>
              tx.create("label_sequences", {
                id,
                last_label: read + 1,
                is_filled: true,
              }),
            );
          }
          for (const move of moves) move();
          return true;
        });
        if (held ? (repairs += 1) <= REPAIRS : (races += 1) <= RACES) {
          continue;
        }
      }
      throw error;
    }
  }
};

/**
 * Labels a scope's releases a server of an earlier release wrote after its
 * newest labeled one, oldest first, before the write takes its own label:
 * `latest` is the scope's newest release, so a labeled one costs no read.
 * Answers the labels it gave, by release ID.
 */
export const catchUpLabels = async (
  tx: CoreTransaction,
  labels: LabelAllocator,
  latest: ReleaseRow | null,
): Promise<Map<string, number>> => {
  const given = new Map<string, number>();
  if (latest === null || typeof latest.label === "number") return given;
  const unlabeled: Awaited<ReturnType<typeof tx.findOne<"releases">>>[] = [];
  let cursor: string | undefined;
  scan: do {
    const page = await tx.findMany("releases", {
      index: "byScope",
      where: { scope_key: latest.scope_key },
      order: "desc",
      limit: FILL_BATCH,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const row of page.rows) {
      if (typeof row.label === "number") break scan;
      unlabeled.push(row);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  labels.caughtUp(latest.channel_id, latest.platform);
  for (const row of unlabeled.reverse()) {
    const { id, channel_id, platform } = toReleaseRow(row!);
    const label = await labels.next(channel_id, platform);
    tx.update("releases", row!, { label });
    given.set(id, label);
  }
  return given;
};

/**
 * The channels and platforms whose releases need labels: a scope whose
 * newest release has none, or a pair without a filled counter. Releases a
 * server of an earlier release wrote in a filled pair come after its
 * labeled ones in their scope, so the newest release of each scope tells.
 * Two reads per scope, one per pair.
 */
export const pendingLabelPairs = async (db: CoreDatabase): Promise<Pair[]> => {
  const pairs = new Map<string, Pair & { pending: boolean }>();
  // No scope key is empty, so the first seek starts past "".
  for (let last = ""; ; ) {
    const { rows } = await db.findMany("releases", {
      index: "scopes",
      where: {},
      limit: 1,
      range: { gt: last },
    });
    if (rows[0] === undefined) break;
    last = rows[0].scope_key;
    const { rows: newest } = await db.findMany("releases", {
      index: "byScope",
      where: { scope_key: last },
      order: "desc",
      limit: 1,
    });
    if (newest[0] === undefined) continue;
    const { channel_id: channelId, platform, label } = toReleaseRow(newest[0]);
    const id = labelSequenceId(channelId, platform);
    const pair = pairs.get(id) ?? { channelId, platform, pending: false };
    pair.pending ||= label === null;
    pairs.set(id, pair);
  }
  const pending: Pair[] = [];
  for (const [id, { channelId, platform, pending: unlabeled }] of pairs) {
    if (!unlabeled) {
      const counter = await db.findOne("label_sequences", { id });
      if (counter !== null && counter.is_filled) continue;
    }
    pending.push({ channelId, platform });
  }
  return pending;
};
