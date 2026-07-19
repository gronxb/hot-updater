import {
  matchesBlobDatabaseWhere,
  queryBlobDatabaseRows,
} from "./blobDatabaseQuery";
import type { BlobDatabaseSnapshot } from "./blobDatabaseSnapshot";
import { normalizeBlobDatabaseSnapshot } from "./blobDatabaseSnapshot";
import type {
  BundleRow,
  DatabaseImplementationResult,
  TransactionDatabaseAdapterImplementation,
} from "./types";

export type BlobSnapshotState = {
  snapshot: BlobDatabaseSnapshot;
};

export class BlobDatabaseConstraintError extends Error {
  readonly name = "BlobDatabaseConstraintError";

  constructor(readonly constraint: string) {
    super(`Blob database constraint failed: ${constraint}`);
  }
}

const requireUniqueId = (
  rows: readonly { readonly id: string }[],
  id: string,
  model: string,
): void => {
  if (rows.some((row) => row.id === id)) {
    throw new BlobDatabaseConstraintError(`${model}.id.unique`);
  }
};

const distinctCount = <TRow extends object>(
  rows: readonly TRow[],
  fields: readonly string[] | undefined,
): number => {
  if (fields === undefined) return rows.length;
  return new Set(
    rows.map((row) =>
      JSON.stringify(fields.map((field) => Reflect.get(row, field))),
    ),
  ).size;
};

export const createBlobSnapshotCrud = (
  state: BlobSnapshotState,
): TransactionDatabaseAdapterImplementation => ({
  async create(input): Promise<DatabaseImplementationResult> {
    const snapshot = state.snapshot;
    switch (input.model) {
      case "bundles": {
        requireUniqueId(snapshot.bundles, input.data.id, input.model);
        if (
          input.data.target_app_version === null &&
          input.data.fingerprint_hash === null
        ) {
          throw new BlobDatabaseConstraintError(
            "bundles.version-or-fingerprint.check",
          );
        }
        state.snapshot = normalizeBlobDatabaseSnapshot({
          ...snapshot,
          bundles: [...snapshot.bundles, input.data],
        });
        return input.data;
      }
      case "bundle_patches": {
        requireUniqueId(snapshot.bundle_patches, input.data.id, input.model);
        const bundleIds = new Set(snapshot.bundles.map(({ id }) => id));
        if (!bundleIds.has(input.data.bundle_id)) {
          throw new BlobDatabaseConstraintError(
            "bundle_patches.bundle_id.foreign-key",
          );
        }
        if (!bundleIds.has(input.data.base_bundle_id)) {
          throw new BlobDatabaseConstraintError(
            "bundle_patches.base_bundle_id.foreign-key",
          );
        }
        state.snapshot = normalizeBlobDatabaseSnapshot({
          ...snapshot,
          bundle_patches: [...snapshot.bundle_patches, input.data],
        });
        return input.data;
      }
      case "bundle_events": {
        requireUniqueId(snapshot.bundle_events, input.data.id, input.model);
        state.snapshot = normalizeBlobDatabaseSnapshot({
          ...snapshot,
          bundle_events: [...snapshot.bundle_events, input.data],
        });
        return input.data;
      }
    }
  },
  async update(input): Promise<Partial<BundleRow> | null> {
    const match = state.snapshot.bundles.find((row) =>
      matchesBlobDatabaseWhere(row, input.where),
    );
    if (!match) return null;
    const updated = { ...match, ...input.update };
    if (
      updated.target_app_version === null &&
      updated.fingerprint_hash === null
    ) {
      throw new BlobDatabaseConstraintError(
        "bundles.version-or-fingerprint.check",
      );
    }
    state.snapshot = normalizeBlobDatabaseSnapshot({
      ...state.snapshot,
      bundles: state.snapshot.bundles.map((row) =>
        row.id === match.id ? updated : row,
      ),
    });
    return updated;
  },
  async delete(input): Promise<void> {
    if (input.model === "bundle_patches") {
      state.snapshot = normalizeBlobDatabaseSnapshot({
        ...state.snapshot,
        bundle_patches: state.snapshot.bundle_patches.filter(
          (row) => !matchesBlobDatabaseWhere(row, input.where),
        ),
      });
      return;
    }
    const removedIds = new Set(
      state.snapshot.bundles
        .filter((row) => matchesBlobDatabaseWhere(row, input.where))
        .map(({ id }) => id),
    );
    state.snapshot = normalizeBlobDatabaseSnapshot({
      ...state.snapshot,
      bundles: state.snapshot.bundles.filter(({ id }) => !removedIds.has(id)),
      bundle_patches: state.snapshot.bundle_patches.filter(
        (row) =>
          !removedIds.has(row.bundle_id) && !removedIds.has(row.base_bundle_id),
      ),
    });
  },
  async count(input): Promise<number> {
    switch (input.model) {
      case "bundles":
        return distinctCount(
          state.snapshot.bundles.filter((row) =>
            matchesBlobDatabaseWhere(row, input.where),
          ),
          input.distinct as readonly string[] | undefined,
        );
      case "bundle_patches":
        return distinctCount(
          state.snapshot.bundle_patches.filter((row) =>
            matchesBlobDatabaseWhere(row, input.where),
          ),
          input.distinct as readonly string[] | undefined,
        );
      case "bundle_events":
        return distinctCount(
          state.snapshot.bundle_events.filter((row) =>
            matchesBlobDatabaseWhere(row, input.where),
          ),
          input.distinct as readonly string[] | undefined,
        );
    }
  },
  async findOne(input): Promise<DatabaseImplementationResult | null> {
    switch (input.model) {
      case "bundles":
        return (
          state.snapshot.bundles.find((row) =>
            matchesBlobDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "bundle_patches":
        return (
          state.snapshot.bundle_patches.find((row) =>
            matchesBlobDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "bundle_events":
        return (
          state.snapshot.bundle_events.find((row) =>
            matchesBlobDatabaseWhere(row, input.where),
          ) ?? null
        );
    }
  },
  async findMany(input): Promise<readonly DatabaseImplementationResult[]> {
    switch (input.model) {
      case "bundles":
        return queryBlobDatabaseRows(state.snapshot.bundles, input);
      case "bundle_patches":
        return queryBlobDatabaseRows(state.snapshot.bundle_patches, input);
      case "bundle_events":
        return queryBlobDatabaseRows(state.snapshot.bundle_events, input);
    }
  },
});
