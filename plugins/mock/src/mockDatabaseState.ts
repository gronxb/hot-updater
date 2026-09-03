import type {
  BundlePatchRow,
  BundleRow,
  ApiKeyRow,
  ChannelRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import type {
  DatabaseImplementationResult,
  TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";

import {
  matchesMockDatabaseWhere,
  queryMockDatabaseRows,
} from "./mockDatabaseQuery";
import {
  createMockInsightsRuntime,
  MOCK_INSIGHTS_DATABASE_NAMESPACES,
  type MockInsightsRuntime,
} from "./mockInsights";

export interface MockDatabaseData {
  readonly bundles: Map<string, BundleRow>;
  readonly bundlePatches: Map<string, BundlePatchRow>;
  readonly insights: MockInsightsRuntime;
  readonly channels: Map<string, ChannelRow>;
  readonly apiKeys: Map<string, ApiKeyRow>;
  readonly releaseCatalogs: Map<string, ReleaseCatalogRow>;
  readonly releases: Map<string, ReleaseRow>;
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
  insights: createMockInsightsRuntime(MOCK_INSIGHTS_DATABASE_NAMESPACES),
  channels: new Map(),
  apiKeys: new Map(),
  releaseCatalogs: new Map(),
  releases: new Map(),
});

export const cloneMockDatabaseData = (
  data: MockDatabaseData,
): MockDatabaseData => ({
  bundles: new Map(data.bundles),
  bundlePatches: new Map(data.bundlePatches),
  insights: data.insights,
  channels: new Map(data.channels),
  apiKeys: new Map(data.apiKeys),
  releaseCatalogs: new Map(data.releaseCatalogs),
  releases: new Map(data.releases),
});

export const replaceMockDatabaseData = (
  target: MockDatabaseData,
  source: MockDatabaseData,
): void => {
  target.bundles.clear();
  target.bundlePatches.clear();
  target.channels.clear();
  target.apiKeys.clear();
  target.releaseCatalogs.clear();
  target.releases.clear();
  for (const [id, row] of source.bundles) target.bundles.set(id, row);
  for (const [id, row] of source.bundlePatches) {
    target.bundlePatches.set(id, row);
  }
  for (const [id, row] of source.channels) {
    target.channels.set(id, row);
  }
  for (const [id, row] of source.apiKeys) {
    target.apiKeys.set(id, row);
  }
  for (const [scopeKey, row] of source.releaseCatalogs) {
    target.releaseCatalogs.set(scopeKey, row);
  }
  for (const [id, row] of source.releases) target.releases.set(id, row);
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
      case "releases":
        requireUnique(data.releases, input.data.id, input.model);
        if (!data.channels.has(input.data.channel_id)) {
          throw new MockDatabaseConstraintError(
            "releases.channel_id.foreign-key",
          );
        }
        if (
          input.data.bundle_id !== null &&
          !data.bundles.has(input.data.bundle_id)
        ) {
          throw new MockDatabaseConstraintError(
            "releases.bundle_id.foreign-key",
          );
        }
        data.releases.set(input.data.id, input.data);
        return input.data;
      case "release_catalogs":
        if (data.releaseCatalogs.has(input.data.scope_key)) {
          throw new MockDatabaseConstraintError(
            "release_catalogs.scope_key.unique",
          );
        }
        data.releaseCatalogs.set(input.data.scope_key, input.data);
        return input.data;
      case "channels": {
        const existing = [...data.channels.values()].find(
          ({ name }) => name === input.data.name,
        );
        if (existing && input.onConflict === "ignore") return existing;
        requireUnique(data.channels, input.data.id, input.model);
        if (existing) {
          throw new MockDatabaseConstraintError("channels.name.unique");
        }
        data.channels.set(input.data.id, input.data);
        return input.data;
      }
      case "api_keys": {
        const existing = [...data.apiKeys.values()].find(
          ({ hash }) => hash === input.data.hash,
        );
        if (existing && input.onConflict === "ignore") return existing;
        requireUnique(data.apiKeys, input.data.id, input.model);
        if (existing) {
          throw new MockDatabaseConstraintError("api_keys.hash.unique");
        }
        data.apiKeys.set(input.data.id, input.data);
        return input.data;
      }
    }
  },
  async update(input): Promise<DatabaseImplementationResult | null> {
    if (input.model === "api_keys") {
      const current = [...data.apiKeys.values()].find((row) =>
        matchesMockDatabaseWhere<"api_keys">(row, input.where),
      );
      if (!current) return null;
      const updated = { ...current, ...input.update };
      data.apiKeys.set(current.id, updated);
      return updated;
    }
    if (input.model === "releases") {
      const current = [...data.releases.values()].find((row) =>
        matchesMockDatabaseWhere<"releases">(row, input.where),
      );
      if (!current) return null;
      const updated = { ...current, ...input.update };
      data.releases.set(current.id, updated);
      return updated;
    }
    if (input.model === "release_catalogs") {
      const current = [...data.releaseCatalogs.values()].find((row) =>
        matchesMockDatabaseWhere<"release_catalogs">(row, input.where),
      );
      if (!current) return null;
      const updated = { ...current, ...input.update };
      data.releaseCatalogs.set(current.scope_key, updated);
      return updated;
    }
    const current = [...data.bundles.values()].find((row) =>
      matchesMockDatabaseWhere(row, input.where),
    );
    if (!current) return null;
    const updated = { ...current, ...input.update };
    data.bundles.set(current.id, updated);
    return updated;
  },
  async delete(input): Promise<void> {
    if (input.model === "channels") {
      for (const row of data.channels.values()) {
        if (matchesMockDatabaseWhere(row, input.where)) {
          data.channels.delete(row.id);
        }
      }
      return;
    }
    if (input.model === "bundle_patches") {
      for (const row of data.bundlePatches.values()) {
        if (matchesMockDatabaseWhere(row, input.where)) {
          data.bundlePatches.delete(row.id);
        }
      }
      return;
    }
    if (input.model === "releases") {
      for (const row of data.releases.values()) {
        if (matchesMockDatabaseWhere<"releases">(row, input.where)) {
          data.releases.delete(row.id);
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
      case "releases":
        return distinctCount(
          [...data.releases.values()].filter((row) =>
            matchesMockDatabaseWhere<"releases">(row, input.where),
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
      case "api_keys":
        return (
          [...data.apiKeys.values()].find((row) =>
            matchesMockDatabaseWhere<"api_keys">(row, input.where),
          ) ?? null
        );
      case "channels":
        return (
          [...data.channels.values()].find((row) =>
            matchesMockDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "bundle_patches":
        return (
          [...data.bundlePatches.values()].find((row) =>
            matchesMockDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "releases":
        return (
          [...data.releases.values()].find((row) =>
            matchesMockDatabaseWhere<"releases">(row, input.where),
          ) ?? null
        );
      case "release_catalogs":
        return (
          [...data.releaseCatalogs.values()].find((row) =>
            matchesMockDatabaseWhere<"release_catalogs">(row, input.where),
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
        return queryMockDatabaseRows<"channels">(
          [...data.channels.values()],
          input,
        );
      case "api_keys":
        return queryMockDatabaseRows<"api_keys">(
          [...data.apiKeys.values()],
          input,
        );
      case "releases":
        return queryMockDatabaseRows<"releases">(
          [...data.releases.values()],
          input,
        );
      case "release_catalogs":
        return queryMockDatabaseRows<"release_catalogs">(
          [...data.releaseCatalogs.values()],
          input,
        );
    }
  },
});
