import type {
  BundlePatchRow,
  BundleRow,
  DatabaseRow,
  DatabaseImplementationResult,
  TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";

import {
  matchesMockDatabaseWhere,
  queryMockDatabaseRows,
} from "./mockDatabaseQuery";

type BundleEventPersistenceRow = DatabaseRow<"bundle_events">;

export interface MockDatabaseData {
  readonly bundles: Map<string, BundleRow>;
  readonly bundlePatches: Map<string, BundlePatchRow>;
  readonly bundleEvents: Map<string, BundleEventPersistenceRow>;
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
  bundleEvents: new Map(),
});

export const cloneMockDatabaseData = (
  data: MockDatabaseData,
): MockDatabaseData => ({
  bundles: new Map(data.bundles),
  bundlePatches: new Map(data.bundlePatches),
  bundleEvents: new Map(data.bundleEvents),
});

export const replaceMockDatabaseData = (
  target: MockDatabaseData,
  source: MockDatabaseData,
): void => {
  target.bundles.clear();
  target.bundlePatches.clear();
  target.bundleEvents.clear();
  for (const [id, row] of source.bundles) target.bundles.set(id, row);
  for (const [id, row] of source.bundlePatches) {
    target.bundlePatches.set(id, row);
  }
  for (const [id, row] of source.bundleEvents) {
    target.bundleEvents.set(id, row);
  }
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

export const createMockDatabaseState = (
  data: MockDatabaseData,
): TransactionDatabasePluginImplementation => ({
  async create(input): Promise<DatabaseImplementationResult> {
    switch (input.model) {
      case "bundles":
        requireUnique(data.bundles, input.data.id, input.model);
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
      case "bundle_events":
        requireUnique(data.bundleEvents, input.data.id, input.model);
        data.bundleEvents.set(input.data.id, input.data);
        return input.data;
    }
  },
  async update(input): Promise<Partial<BundleRow> | null> {
    const current = [...data.bundles.values()].find((row) =>
      matchesMockDatabaseWhere(row, input.where),
    );
    if (!current) return null;
    const updated = { ...current, ...input.update };
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
    switch (input.model) {
      case "bundles":
        return distinctCount(
          [...data.bundles.values()].filter((row) =>
            matchesMockDatabaseWhere(row, input.where),
          ),
          input.distinct as readonly string[] | undefined,
        );
      case "bundle_patches":
        return distinctCount(
          [...data.bundlePatches.values()].filter((row) =>
            matchesMockDatabaseWhere(row, input.where),
          ),
          input.distinct as readonly string[] | undefined,
        );
      case "bundle_events":
        return distinctCount(
          [...data.bundleEvents.values()].filter((row) =>
            matchesMockDatabaseWhere(row, input.where),
          ),
          input.distinct as readonly string[] | undefined,
        );
    }
  },
  async findOne(input): Promise<DatabaseImplementationResult | null> {
    switch (input.model) {
      case "bundles":
        return (
          [...data.bundles.values()].find((row) =>
            matchesMockDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "bundle_patches":
        return (
          [...data.bundlePatches.values()].find((row) =>
            matchesMockDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "bundle_events":
        return (
          [...data.bundleEvents.values()].find((row) =>
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
      case "bundle_events":
        return queryMockDatabaseRows([...data.bundleEvents.values()], input);
    }
  },
});
