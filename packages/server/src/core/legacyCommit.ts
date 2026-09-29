import {
  DatabasePluginInputError,
  type DatabaseChange,
  type DatabaseCommit,
  type DatabaseCommitExpectation,
  type DatabaseCommitResult,
  type ReleaseRow,
} from "@hot-updater/plugin-core";
import { validateDatabaseCommit } from "@hot-updater/plugin-core/internal";

import { DatabaseConstraintError } from "../database/errors";
import { compiledGeneration, toReleaseRow } from "./reads";
import {
  deleteBundle,
  deleteBundlePatches,
  insertBundle,
  moveBaseCandidates,
  updateBundle,
  type CoreTransaction,
} from "./writes";

type Conflict = Extract<DatabaseCommitResult, { committed: false }>;

class CommitConflict extends Error {
  constructor(readonly result: Conflict) {
    super("The commit's precondition failed.");
  }
}

const conflict = (
  changeIndex: number,
  reason: "not_found" | "referenced",
): CommitConflict =>
  new CommitConflict({ committed: false, conflict: { changeIndex, reason } });

const checkExpectation = async (
  tx: CoreTransaction,
  expectation: DatabaseCommitExpectation,
): Promise<void> => {
  const [key, expectedVersion, actualVersion] =
    expectation.model === "releases"
      ? [
          expectation.id,
          expectation.revision,
          (await tx.findOne("releases", { id: expectation.id }))?.revision ??
            null,
        ]
      : [
          expectation.scopeKey,
          expectation.generation,
          compiledGeneration(
            await tx.findOne("release_catalogs", {
              scope_key: expectation.scopeKey,
            }),
          ),
        ];
  if (actualVersion !== expectedVersion) {
    throw new CommitConflict({
      committed: false,
      conflict: {
        changeIndex: -1,
        reason: "version_conflict",
        model: expectation.model,
        key,
        expectedVersion,
        actualVersion,
      },
    });
  }
};

/** Gives every scope a release was written in a catalog row for its bump. */
const ensureCatalogs = async (
  tx: CoreTransaction,
  scopes: ReadonlyMap<string, ReleaseRow>,
): Promise<void> => {
  for (const [scopeKey, release] of scopes) {
    if (await tx.findOne("release_catalogs", { scope_key: scopeKey })) continue;
    tx.create("release_catalogs", {
      scope_key: scopeKey,
      catalog_id: "",
      strategy: release.strategy,
      channel_id: release.channel_id,
      channel_key: "",
      platform: release.platform,
      fingerprint_hash: release.fingerprint_hash,
      generation: 0,
      payload: "",
      catalog_hash: "",
      byte_size: 0,
      is_tombstone: true,
      updated_at_ms: release.updated_at_ms,
    });
  }
};

/** A change core does not own: API keys belong to the api-keys plugin. */
export type ExternalChange = Extract<
  DatabaseChange,
  { readonly model: "apiKeys" }
>;

const applyChange = async (
  tx: CoreTransaction,
  change: Exclude<DatabaseChange, ExternalChange>,
  changeIndex: number,
  scopes: Map<string, ReleaseRow>,
  puts: Set<string>,
): Promise<void> => {
  switch (change.model) {
    case "bundles": {
      if (change.operation === "insert") return insertBundle(tx, change.row);
      const current = await tx.findOne("bundles", { id: change.where.id });
      if (change.operation === "update") {
        if (current === null) throw conflict(changeIndex, "not_found");
        return updateBundle(tx, current, change.update);
      }
      if (current !== null) await deleteBundle(tx, current);
      return;
    }
    case "bundlePatches": {
      if (change.operation === "insert") {
        tx.create("bundle_patches", change.row);
        return;
      }
      const bundle = await tx.findOne("bundles", { id: change.where.bundleId });
      if (bundle !== null) await deleteBundlePatches(tx, bundle);
      return;
    }
    case "releases": {
      if (change.operation === "insert") {
        const { row } = change;
        if (row.bundle_id !== null) {
          const bundle = await tx.findOne("bundles", { id: row.bundle_id });
          if (bundle !== null && bundle.platform !== row.platform) {
            throw new DatabasePluginInputError("invalid-data");
          }
        }
        tx.create("releases", row);
        moveBaseCandidates(tx, null, row);
        scopes.set(row.scope_key, row);
        return;
      }
      const stored = await tx.findOne("releases", { id: change.where.id });
      const current = stored === null ? null : toReleaseRow(stored);
      if (stored === null || current === null) {
        if (change.operation === "update") {
          throw conflict(changeIndex, "not_found");
        }
        return;
      }
      scopes.set(current.scope_key, current);
      if (change.operation === "delete") {
        await tx.delete("releases", stored);
        moveBaseCandidates(tx, current, null);
        return;
      }
      const next = { ...current, ...change.update };
      tx.update("releases", stored, change.update);
      moveBaseCandidates(tx, current, next);
      scopes.set(next.scope_key, next);
      return;
    }
    case "releaseCatalogs": {
      const { scope_key: scopeKey, ...rest } = change.row;
      const current = await tx.findOne("release_catalogs", {
        scope_key: scopeKey,
      });
      if (current === null) tx.create("release_catalogs", change.row);
      else tx.update("release_catalogs", current, rest);
      puts.add(scopeKey);
      return;
    }
    case "channels": {
      if (change.operation === "insert") {
        const { row } = change;
        // onConflict "ignore": a taken id or name leaves the stored row.
        if (await tx.findOne("channels", { id: row.id })) return;
        if (await tx.findOne("channels", { name: row.name })) return;
        tx.create("channels", row);
        return;
      }
      const current = await tx.findOne("channels", { id: change.where.id });
      if (current !== null) await tx.delete("channels", current);
      return;
    }
  }
};

const noExternalChanges = async (): Promise<never> => {
  throw new DatabasePluginInputError("invalid-model");
};

/**
 * Today's `DatabaseCommit` on the engine, for the legacy façade until E2:
 * expectations first, then each change in order, in one transaction.
 * `external` applies the changes core does not own in the same transaction;
 * answering `not_found` fails the commit at that change.
 */
export const commitLegacyChanges = async <TTx extends CoreTransaction>(
  db: {
    transaction<R>(fn: (tx: TTx) => Promise<R>): Promise<R>;
  },
  input: DatabaseCommit,
  external: (
    tx: TTx,
    change: ExternalChange,
  ) => Promise<"not_found" | undefined> = noExternalChanges,
): Promise<DatabaseCommitResult> => {
  validateDatabaseCommit(input);
  try {
    return await db.transaction(async (tx) => {
      for (const expectation of input.expectations ?? []) {
        await checkExpectation(tx, expectation);
      }
      const scopes = new Map<string, ReleaseRow>();
      const puts = new Set<string>();
      for (const [changeIndex, change] of input.changes.entries()) {
        try {
          if (change.model !== "apiKeys") {
            await applyChange(tx, change, changeIndex, scopes, puts);
          } else if ((await external(tx, change)) === "not_found") {
            throw conflict(changeIndex, "not_found");
          }
        } catch (error) {
          if (
            error instanceof DatabaseConstraintError &&
            error.reason === "referenced"
          ) {
            throw conflict(changeIndex, "referenced");
          }
          throw error;
        }
      }
      for (const scopeKey of puts) scopes.delete(scopeKey);
      await ensureCatalogs(tx, scopes);
      return { committed: true } as const;
    });
  } catch (error) {
    if (error instanceof CommitConflict) return error.result;
    throw error;
  }
};
