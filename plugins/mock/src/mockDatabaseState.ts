import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabaseImplementationResult,
  TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";

import {
  matchesMockDatabaseWhere,
  queryMockDatabaseRows,
} from "./mockDatabaseQuery";

export interface MockDatabaseData {
  readonly bundles: Map<string, BundleRow>;
  readonly bundlePatches: Map<string, BundlePatchRow>;
  readonly channels: Map<string, ChannelRow>;
}

export class MockDatabaseConstraintError extends Error {
  readonly name = "MockDatabaseConstraintError";

  constructor(readonly constraint: string) {
    super(`Mock database constraint failed: ${constraint}`);
  }
}

export const createMockDatabaseData = (): MockDatabaseData => ({
  bundles: new Map(),
  bundlePatches: new Map(),
  channels: new Map(),
});

export const cloneMockDatabaseData = (
  data: MockDatabaseData,
): MockDatabaseData => ({
  bundles: new Map(data.bundles),
  bundlePatches: new Map(data.bundlePatches),
  channels: new Map(data.channels),
});

export const replaceMockDatabaseData = (
  target: MockDatabaseData,
  source: MockDatabaseData,
): void => {
  target.bundles.clear();
  target.bundlePatches.clear();
  target.channels.clear();
  for (const [id, row] of source.bundles) target.bundles.set(id, row);
  for (const [id, row] of source.bundlePatches) {
    target.bundlePatches.set(id, row);
  }
  for (const [id, row] of source.channels) target.channels.set(id, row);
};

const requireUnique = (
  rows: ReadonlyMap<string, { readonly id: string }>,
  id: string,
  model: string,
): void => {
  if (rows.has(id)) {
    throw new MockDatabaseConstraintError(`${model}.id.unique`);
  }
};

export const createMockDatabaseState = (
  data: MockDatabaseData,
): TransactionDatabasePluginImplementation => ({
  async create(input): Promise<DatabaseImplementationResult> {
    switch (input.model) {
      case "channels":
        requireUnique(data.channels, input.data.id, input.model);
        data.channels.set(input.data.id, input.data);
        return input.data;
      case "bundles":
        requireUnique(data.bundles, input.data.id, input.model);
        if (!data.channels.has(input.data.channel)) {
          throw new MockDatabaseConstraintError("bundles.channel.foreign-key");
        }
        data.bundles.set(input.data.id, input.data);
        return input.data;
      case "bundle_patches":
        requireUnique(data.bundlePatches, input.data.id, input.model);
        if (!data.bundles.has(input.data.bundle_id)) {
          throw new MockDatabaseConstraintError(
            "bundle_patches.bundle_id.foreign-key",
          );
        }
        if (!data.bundles.has(input.data.base_bundle_id)) {
          throw new MockDatabaseConstraintError(
            "bundle_patches.base_bundle_id.foreign-key",
          );
        }
        data.bundlePatches.set(input.data.id, input.data);
        return input.data;
    }
  },
  async update(input): Promise<Partial<BundleRow> | null> {
    const current = [...data.bundles.values()].find((row) =>
      matchesMockDatabaseWhere(row, input.where),
    );
    if (!current) return null;
    const updated = { ...current, ...input.update };
    if (!data.channels.has(updated.channel)) {
      throw new MockDatabaseConstraintError("bundles.channel.foreign-key");
    }
    data.bundles.set(current.id, updated);
    return updated;
  },
  async delete(input): Promise<void> {
    if (input.model === "bundle_patches") {
      for (const row of data.bundlePatches.values()) {
        if (matchesMockDatabaseWhere(row, input.where)) {
          data.bundlePatches.delete(row.id);
        }
      }
      return;
    }
    const removedIds = new Set(
      [...data.bundles.values()]
        .filter((row) => matchesMockDatabaseWhere(row, input.where))
        .map(({ id }) => id),
    );
    for (const id of removedIds) data.bundles.delete(id);
    for (const patch of data.bundlePatches.values()) {
      if (
        removedIds.has(patch.bundle_id) ||
        removedIds.has(patch.base_bundle_id)
      ) {
        data.bundlePatches.delete(patch.id);
      }
    }
  },
  async count(input): Promise<number> {
    return [...data.bundles.values()].filter((row) =>
      matchesMockDatabaseWhere(row, input.where),
    ).length;
  },
  async findOne(input): Promise<DatabaseImplementationResult | null> {
    switch (input.model) {
      case "bundles":
        return (
          [...data.bundles.values()].find((row) =>
            matchesMockDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "channels":
        return (
          [...data.channels.values()].find((row) =>
            matchesMockDatabaseWhere(row, input.where),
          ) ?? null
        );
    }
  },
  async findMany(input): Promise<readonly DatabaseImplementationResult[]> {
    switch (input.model) {
      case "bundles":
        return queryMockDatabaseRows([...data.bundles.values()], input);
      case "bundle_patches":
        return queryMockDatabaseRows([...data.bundlePatches.values()], input);
      case "channels":
        return queryMockDatabaseRows([...data.channels.values()], input);
    }
  },
});
