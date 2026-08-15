import {
  matchesBlobDatabaseWhere,
  queryBlobDatabaseRows,
} from "./blobDatabaseQuery";
import type { BlobDatabaseSnapshot } from "./blobDatabaseSnapshot";
import {
  assertBlobDatabaseSnapshotCompatible,
  normalizeBlobDatabaseSnapshot,
} from "./blobDatabaseSnapshot";
import {
  parseBundleEventRow,
  parseBundleRow,
  parseChannelRow,
  parseClientAccessKeyRow,
} from "./blobDatabaseSnapshotRows";
import { DatabaseRowReferencedError } from "./createDatabasePlugin";
import type {
  BundleRow,
  ClientAccessKeyRow,
  DatabaseImplementationResult,
  TransactionDatabasePluginImplementation,
} from "./types/internal";

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

const requireBundleChannel = (
  snapshot: BlobDatabaseSnapshot,
  row: Pick<BundleRow, "channel" | "channel_id">,
): void => {
  const channel = snapshot.channels.find(({ id }) => id === row.channel_id);
  if (channel?.name !== row.channel) {
    throw new BlobDatabaseConstraintError("bundles.channel_id.foreign-key");
  }
};

export const createBlobSnapshotCrud = (
  state: BlobSnapshotState,
): TransactionDatabasePluginImplementation => ({
  async create(input): Promise<DatabaseImplementationResult> {
    const snapshot = state.snapshot;
    assertBlobDatabaseSnapshotCompatible(snapshot);
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
        requireBundleChannel(snapshot, input.data);
        const row = parseBundleRow(input.data, `bundles/${input.data.id}`);
        state.snapshot = normalizeBlobDatabaseSnapshot({
          ...snapshot,
          bundles: [...snapshot.bundles, row],
        });
        return row;
      }
      case "channels": {
        const existingByName = snapshot.channels.find(
          ({ name }) => name === input.data.name,
        );
        if (existingByName && input.onConflict === "ignore") {
          return existingByName;
        }
        const existingById = snapshot.channels.find(
          ({ id }) => id === input.data.id,
        );
        if (
          existingById &&
          input.onConflict === "ignore" &&
          existingById.name === input.data.name
        ) {
          return existingById;
        }
        requireUniqueId(snapshot.channels, input.data.id, input.model);
        if (existingByName) {
          throw new BlobDatabaseConstraintError("channels.name.unique");
        }
        const row = parseChannelRow(input.data, `channels/${input.data.id}`);
        state.snapshot = normalizeBlobDatabaseSnapshot({
          ...snapshot,
          channels: [...snapshot.channels, row],
        });
        return row;
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
        const row = parseBundleEventRow(
          input.data,
          `bundle_events/${input.data.id}`,
        );
        state.snapshot = normalizeBlobDatabaseSnapshot({
          ...snapshot,
          bundle_events: [...snapshot.bundle_events, row],
        });
        return row;
      }
      case "client_access_keys": {
        const existingByHash = snapshot.client_access_keys.find(
          ({ hash }) => hash === input.data.hash,
        );
        if (existingByHash && input.onConflict === "ignore") {
          return existingByHash;
        }
        const existingById = snapshot.client_access_keys.find(
          ({ id }) => id === input.data.id,
        );
        if (
          existingById &&
          input.onConflict === "ignore" &&
          existingById.hash === input.data.hash
        ) {
          return existingById;
        }
        requireUniqueId(
          snapshot.client_access_keys,
          input.data.id,
          input.model,
        );
        if (existingByHash !== undefined) {
          throw new BlobDatabaseConstraintError(
            "client_access_keys.hash.unique",
          );
        }
        const row = parseClientAccessKeyRow(
          input.data,
          `client_access_keys/${input.data.id}`,
        );
        state.snapshot = normalizeBlobDatabaseSnapshot({
          ...snapshot,
          client_access_keys: [...snapshot.client_access_keys, row],
        });
        return row;
      }
    }
  },
  async update(input): Promise<Partial<BundleRow | ClientAccessKeyRow> | null> {
    assertBlobDatabaseSnapshotCompatible(state.snapshot);
    if (input.model === "client_access_keys") {
      const match = state.snapshot.client_access_keys.find((row) =>
        matchesBlobDatabaseWhere(row, input.where),
      );
      if (!match) return null;
      const updatedRow = parseClientAccessKeyRow(
        { ...match, ...input.update },
        `client_access_keys/${match.id}`,
      );
      state.snapshot = normalizeBlobDatabaseSnapshot({
        ...state.snapshot,
        client_access_keys: state.snapshot.client_access_keys.map((row) =>
          row.id === match.id ? updatedRow : row,
        ),
      });
      return updatedRow;
    }
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
    requireBundleChannel(state.snapshot, updated);
    const updatedRow = parseBundleRow(updated, `bundles/${updated.id}`);
    state.snapshot = normalizeBlobDatabaseSnapshot({
      ...state.snapshot,
      bundles: state.snapshot.bundles.map((row) =>
        row.id === match.id ? updatedRow : row,
      ),
    });
    return updatedRow;
  },
  async delete(input): Promise<void> {
    assertBlobDatabaseSnapshotCompatible(state.snapshot);
    if (input.model === "bundle_patches") {
      state.snapshot = normalizeBlobDatabaseSnapshot({
        ...state.snapshot,
        bundle_patches: state.snapshot.bundle_patches.filter(
          (row) => !matchesBlobDatabaseWhere(row, input.where),
        ),
      });
      return;
    }
    if (input.model === "channels") {
      const removedIds = new Set(
        state.snapshot.channels
          .filter((row) => matchesBlobDatabaseWhere(row, input.where))
          .map(({ id }) => id),
      );
      if (
        state.snapshot.bundles.some(({ channel_id }) =>
          removedIds.has(channel_id),
        )
      ) {
        throw new DatabaseRowReferencedError();
      }
      state.snapshot = normalizeBlobDatabaseSnapshot({
        ...state.snapshot,
        channels: state.snapshot.channels.filter(
          ({ id }) => !removedIds.has(id),
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
      case "client_access_keys":
        return (
          state.snapshot.client_access_keys.find((row) =>
            matchesBlobDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "channels":
        return (
          state.snapshot.channels.find((row) =>
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
      case "client_access_keys":
        return queryBlobDatabaseRows(state.snapshot.client_access_keys, input);
      case "channels":
        return queryBlobDatabaseRows(state.snapshot.channels, input);
    }
  },
});
