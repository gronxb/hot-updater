import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  DatabaseImplementationResult,
  TransactionDatabaseAdapterImplementation,
} from "@hot-updater/plugin-core";

import {
  matchesFirebaseDatabaseWhere,
  queryFirebaseDatabaseRows,
} from "./firebaseDatabaseQuery";

export interface FirebaseDatabaseSnapshot {
  readonly bundles: Map<string, BundleRow>;
  readonly bundlePatches: Map<string, BundlePatchRow>;
  readonly bundleEvents: Map<string, BundleEventRow>;
}

export class FirebaseDatabaseConstraintError extends Error {
  readonly name = "FirebaseDatabaseConstraintError";

  constructor(readonly constraint: string) {
    super(`Firebase database constraint failed: ${constraint}`);
  }
}

export const cloneFirebaseDatabaseSnapshot = (
  snapshot: FirebaseDatabaseSnapshot,
): FirebaseDatabaseSnapshot => ({
  bundles: new Map(snapshot.bundles),
  bundlePatches: new Map(snapshot.bundlePatches),
  bundleEvents: new Map(snapshot.bundleEvents),
});

const requireUnique = (
  rows: ReadonlyMap<string, { readonly id: string }>,
  id: string,
  model: string,
): void => {
  if (rows.has(id)) {
    throw new FirebaseDatabaseConstraintError(`${model}.id.unique`);
  }
};

const distinctCount = <TRow extends object>(
  rows: readonly TRow[],
  fields: readonly string[] | undefined,
): number => {
  if (fields === undefined) return rows.length;
  const seen = new Set(
    rows.map((row) =>
      JSON.stringify(fields.map((field) => Reflect.get(row, field))),
    ),
  );
  return seen.size;
};

export const createFirebaseDatabaseState = (
  snapshot: FirebaseDatabaseSnapshot,
): TransactionDatabaseAdapterImplementation => ({
  async create(input): Promise<DatabaseImplementationResult> {
    switch (input.model) {
      case "bundles":
        requireUnique(snapshot.bundles, input.data.id, input.model);
        if (
          input.data.target_app_version === null &&
          input.data.fingerprint_hash === null
        ) {
          throw new FirebaseDatabaseConstraintError(
            "bundles.version-or-fingerprint.check",
          );
        }
        snapshot.bundles.set(input.data.id, input.data);
        return input.data;
      case "bundle_patches":
        requireUnique(snapshot.bundlePatches, input.data.id, input.model);
        if (!snapshot.bundles.has(input.data.bundle_id)) {
          throw new FirebaseDatabaseConstraintError(
            "bundle_patches.bundle_id.foreign-key",
          );
        }
        if (!snapshot.bundles.has(input.data.base_bundle_id)) {
          throw new FirebaseDatabaseConstraintError(
            "bundle_patches.base_bundle_id.foreign-key",
          );
        }
        snapshot.bundlePatches.set(input.data.id, input.data);
        return input.data;
      case "bundle_events":
        requireUnique(snapshot.bundleEvents, input.data.id, input.model);
        snapshot.bundleEvents.set(input.data.id, input.data);
        return input.data;
    }
  },
  async update(input): Promise<Partial<BundleRow> | null> {
    const current = [...snapshot.bundles.values()].find((row) =>
      matchesFirebaseDatabaseWhere(row, input.where),
    );
    if (!current) return null;
    const updated = { ...current, ...input.update };
    if (
      updated.target_app_version === null &&
      updated.fingerprint_hash === null
    ) {
      throw new FirebaseDatabaseConstraintError(
        "bundles.version-or-fingerprint.check",
      );
    }
    snapshot.bundles.set(current.id, updated);
    return updated;
  },
  async delete(input): Promise<void> {
    if (input.model === "bundle_patches") {
      for (const row of snapshot.bundlePatches.values()) {
        if (matchesFirebaseDatabaseWhere(row, input.where)) {
          snapshot.bundlePatches.delete(row.id);
        }
      }
      return;
    }
    const removedIds = new Set(
      [...snapshot.bundles.values()]
        .filter((row) => matchesFirebaseDatabaseWhere(row, input.where))
        .map(({ id }) => id),
    );
    for (const id of removedIds) snapshot.bundles.delete(id);
    for (const patch of snapshot.bundlePatches.values()) {
      if (
        removedIds.has(patch.bundle_id) ||
        removedIds.has(patch.base_bundle_id)
      ) {
        snapshot.bundlePatches.delete(patch.id);
      }
    }
  },
  async count(input): Promise<number> {
    switch (input.model) {
      case "bundles":
        return distinctCount(
          [...snapshot.bundles.values()].filter((row) =>
            matchesFirebaseDatabaseWhere(row, input.where),
          ),
          input.distinct as readonly string[] | undefined,
        );
      case "bundle_patches":
        return distinctCount(
          [...snapshot.bundlePatches.values()].filter((row) =>
            matchesFirebaseDatabaseWhere(row, input.where),
          ),
          input.distinct as readonly string[] | undefined,
        );
      case "bundle_events":
        return distinctCount(
          [...snapshot.bundleEvents.values()].filter((row) =>
            matchesFirebaseDatabaseWhere(row, input.where),
          ),
          input.distinct as readonly string[] | undefined,
        );
    }
  },
  async findOne(input): Promise<DatabaseImplementationResult | null> {
    switch (input.model) {
      case "bundles":
        return (
          [...snapshot.bundles.values()].find((row) =>
            matchesFirebaseDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "bundle_patches":
        return (
          [...snapshot.bundlePatches.values()].find((row) =>
            matchesFirebaseDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "bundle_events":
        return (
          [...snapshot.bundleEvents.values()].find((row) =>
            matchesFirebaseDatabaseWhere(row, input.where),
          ) ?? null
        );
    }
  },
  async findMany(input): Promise<readonly DatabaseImplementationResult[]> {
    switch (input.model) {
      case "bundles":
        return queryFirebaseDatabaseRows([...snapshot.bundles.values()], input);
      case "bundle_patches":
        return queryFirebaseDatabaseRows(
          [...snapshot.bundlePatches.values()],
          input,
        );
      case "bundle_events":
        return queryFirebaseDatabaseRows(
          [...snapshot.bundleEvents.values()],
          input,
        );
    }
  },
});
