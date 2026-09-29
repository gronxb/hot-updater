import type {
  BundlePatchRow,
  BundleRow,
  BundleRowUpdate,
  ChannelDeleteResult,
  ChannelInsertResult,
  ChannelRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";

import type { HotUpdaterTransaction, TableRow } from "../database/database";
import { DatabaseConstraintError } from "../database/errors";
import { releaseBaseCandidateKeys } from "./baseCandidates";
import { toChannelRow, type CoreDatabase } from "./reads";
import type { CoreSchema } from "./schema";

export type CoreTransaction = HotUpdaterTransaction<CoreSchema>;
export type StoredBundle = TableRow<CoreSchema["bundles"]>;

const PAGE = 500;

/** Moves one bundle into or out of its platform's total and the overall total. */
const countBundle = (tx: CoreTransaction, platform: string, delta: number) => {
  for (const key of [platform, "*"]) {
    tx.aggregate("bundle_totals", { platform_key: key }, { bundles: delta });
  }
};

export const insertBundle = (tx: CoreTransaction, row: BundleRow): void => {
  tx.create("bundles", row);
  countBundle(tx, row.platform, 1);
};

export const updateBundle = (
  tx: CoreTransaction,
  current: StoredBundle,
  set: BundleRowUpdate,
): void => {
  tx.update("bundles", current, set);
  if (set.platform !== undefined && set.platform !== current.platform) {
    countBundle(tx, current.platform, -1);
    countBundle(tx, set.platform, 1);
  }
};

/** Deletes a bundle and, by cascade, every patch to or from it; a release on it refuses. */
export const deleteBundle = async (
  tx: CoreTransaction,
  current: StoredBundle,
): Promise<void> => {
  await tx.delete("bundles", current);
  countBundle(tx, current.platform, -1);
};

/** Deletes a bundle's own patches, exactly as many as its counter holds. */
export const deleteBundlePatches = async (
  tx: CoreTransaction,
  bundle: StoredBundle,
): Promise<void> => {
  const count = bundle._refs_bundle_patches_bundle_id ?? 0;
  let cursor: string | undefined;
  for (let seen = 0; seen < count; ) {
    const page = await tx.findMany("bundle_patches", {
      index: "byBundle",
      where: { bundle_id: bundle.id },
      limit: Math.min(count - seen, PAGE),
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const row of page.rows) await tx.delete("bundle_patches", row);
    seen += page.rows.length;
    if (page.next === undefined) break;
    cursor = page.next;
  }
};

/**
 * Replaces a bundle's patches with `rows`: kept patches are updated where
 * they changed, others deleted or created, so no key is written twice.
 */
export const replaceBundlePatches = async (
  tx: CoreTransaction,
  bundle: StoredBundle,
  rows: readonly BundlePatchRow[],
): Promise<void> => {
  const wanted = new Map(rows.map((row) => [row.id, row]));
  const count = bundle._refs_bundle_patches_bundle_id ?? 0;
  let cursor: string | undefined;
  for (let seen = 0; seen < count; ) {
    const page = await tx.findMany("bundle_patches", {
      index: "byBundle",
      where: { bundle_id: bundle.id },
      limit: Math.min(count - seen, PAGE),
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const stored of page.rows) {
      const next = wanted.get(stored.id);
      wanted.delete(stored.id);
      if (next === undefined) {
        await tx.delete("bundle_patches", stored);
        continue;
      }
      const set = Object.fromEntries(
        Object.entries(next).filter(
          ([field, value]) =>
            field !== "id" &&
            (stored as Record<string, unknown>)[field] !== value,
        ),
      );
      if (Object.keys(set).length > 0) {
        tx.update("bundle_patches", stored, set);
      }
    }
    seen += page.rows.length;
    if (page.next === undefined) break;
    cursor = page.next;
  }
  for (const row of wanted.values()) tx.create("bundle_patches", row);
};

/** Moves a release's `base_candidates` gauges from its old keys to its new ones. */
export const moveBaseCandidates = (
  tx: CoreTransaction,
  before: ReleaseRow | null,
  after: ReleaseRow | null,
): void => {
  const deltas = new Map<string, number>();
  for (const [row, delta] of [
    [before, -1],
    [after, 1],
  ] as const) {
    if (row === null) continue;
    for (const key of releaseBaseCandidateKeys(row)) {
      const id = JSON.stringify([key, row.bundle_id]);
      deltas.set(id, (deltas.get(id) ?? 0) + delta);
    }
  }
  for (const [id, delta] of deltas) {
    if (delta === 0) continue;
    const [candidateKey, bundleId] = JSON.parse(id) as [string, string];
    tx.aggregate(
      "base_candidates",
      { candidate_key: candidateKey, bundle_id: bundleId },
      { releases: delta },
    );
  }
};

/** A channel by name, created when missing; a concurrent creator's row is returned instead. */
export const insertChannel = async (
  db: CoreDatabase,
  row: ChannelRow,
): Promise<ChannelInsertResult> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const existing = await tx.findOne("channels", { name: row.name });
        if (existing !== null) {
          return { row: toChannelRow(existing), inserted: false };
        }
        tx.create("channels", row);
        return { row, inserted: true };
      });
    } catch (error) {
      // Another writer took the name, or the id, first: read again.
      if (
        attempt < 3 &&
        error instanceof DatabaseConstraintError &&
        (error.reason === "unique" || error.reason === "exists")
      ) {
        continue;
      }
      throw error;
    }
  }
};

/** Deletes a channel no release uses: 1 read + 1 write. */
export const deleteChannel = (
  db: CoreDatabase,
  id: string,
): Promise<ChannelDeleteResult> =>
  db.transaction(async (tx) => {
    const row = await tx.findOne("channels", { id });
    if (row === null) return { deleted: false, reason: "not_found" };
    if ((row._refs_releases_channel_id ?? 0) > 0) {
      return { deleted: false, reason: "not_empty" };
    }
    await tx.delete("channels", row);
    return { deleted: true };
  });
