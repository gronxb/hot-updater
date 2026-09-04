import type {
  BundlePatchRow,
  BundleRow,
  BundleEventRow,
  InsightsInstallationRow,
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
  matchesFirebaseDatabaseWhere,
  queryFirebaseDatabaseRows,
} from "./firebaseDatabaseQuery";

export interface FirebaseDatabaseSnapshot {
  readonly bundles: Map<string, BundleRow>;
  readonly bundlePatches: Map<string, BundlePatchRow>;
  readonly bundleEvents: Map<string, BundleEventRow>;
  readonly bundleInstallations: Map<string, InsightsInstallationRow>;
  readonly channels: Map<string, ChannelRow>;
  readonly apiKeys: Map<string, ApiKeyRow>;
  readonly releaseCatalogs: Map<string, ReleaseCatalogRow>;
  readonly releases: Map<string, ReleaseRow>;
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
  bundleInstallations: new Map(snapshot.bundleInstallations),
  channels: new Map(snapshot.channels),
  apiKeys: new Map(snapshot.apiKeys),
  releaseCatalogs: new Map(snapshot.releaseCatalogs),
  releases: new Map(snapshot.releases),
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
): TransactionDatabasePluginImplementation => ({
  async create(input): Promise<DatabaseImplementationResult> {
    switch (input.model) {
      case "bundles":
        requireUnique(snapshot.bundles, input.data.id, input.model);
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
      case "bundle_installations": {
        const current = snapshot.bundleInstallations.get(input.data.install_id);
        if (current && input.onConflict === "ignore") return current;
        if (current) {
          throw new FirebaseDatabaseConstraintError(
            "bundle_installations.install_id.unique",
          );
        }
        snapshot.bundleInstallations.set(input.data.install_id, input.data);
        return input.data;
      }
      case "releases":
        requireUnique(snapshot.releases, input.data.id, input.model);
        if (!snapshot.channels.has(input.data.channel_id)) {
          throw new FirebaseDatabaseConstraintError(
            "releases.channel_id.foreign-key",
          );
        }
        if (
          input.data.bundle_id !== null &&
          !snapshot.bundles.has(input.data.bundle_id)
        ) {
          throw new FirebaseDatabaseConstraintError(
            "releases.bundle_id.foreign-key",
          );
        }
        snapshot.releases.set(input.data.id, input.data);
        return input.data;
      case "release_catalogs":
        if (snapshot.releaseCatalogs.has(input.data.scope_key)) {
          throw new FirebaseDatabaseConstraintError(
            "release_catalogs.scope_key.unique",
          );
        }
        snapshot.releaseCatalogs.set(input.data.scope_key, input.data);
        return input.data;
      case "channels": {
        const existing = [...snapshot.channels.values()].find(
          ({ name }) => name === input.data.name,
        );
        if (existing && input.onConflict === "ignore") return existing;
        requireUnique(snapshot.channels, input.data.id, input.model);
        if (existing) {
          throw new FirebaseDatabaseConstraintError("channels.name.unique");
        }
        snapshot.channels.set(input.data.id, input.data);
        return input.data;
      }
      case "api_keys": {
        const existing = [...snapshot.apiKeys.values()].find(
          ({ hash }) => hash === input.data.hash,
        );
        if (existing && input.onConflict === "ignore") return existing;
        requireUnique(snapshot.apiKeys, input.data.id, input.model);
        if (existing) {
          throw new FirebaseDatabaseConstraintError("api_keys.hash.unique");
        }
        snapshot.apiKeys.set(input.data.id, input.data);
        return input.data;
      }
    }
  },
  async update(input): Promise<DatabaseImplementationResult | null> {
    if (input.model === "bundle_installations") {
      const current = [...snapshot.bundleInstallations.values()].find((row) =>
        matchesFirebaseDatabaseWhere<"bundle_installations">(row, input.where),
      );
      if (!current) return null;
      const updated = { ...current, ...input.update };
      snapshot.bundleInstallations.set(current.install_id, updated);
      return updated;
    }
    if (input.model === "api_keys") {
      const current = [...snapshot.apiKeys.values()].find((row) =>
        matchesFirebaseDatabaseWhere(row, input.where),
      );
      if (!current) return null;
      const updated = { ...current, ...input.update };
      snapshot.apiKeys.set(current.id, updated);
      return updated;
    }
    if (input.model === "releases") {
      const current = [...snapshot.releases.values()].find((row) =>
        matchesFirebaseDatabaseWhere<"releases">(row, input.where),
      );
      if (!current) return null;
      const updated = { ...current, ...input.update };
      snapshot.releases.set(current.id, updated);
      return updated;
    }
    if (input.model === "release_catalogs") {
      const current = [...snapshot.releaseCatalogs.values()].find((row) =>
        matchesFirebaseDatabaseWhere<"release_catalogs">(row, input.where),
      );
      if (!current) return null;
      const updated = { ...current, ...input.update };
      snapshot.releaseCatalogs.set(current.scope_key, updated);
      return updated;
    }
    const current = [...snapshot.bundles.values()].find((row) =>
      matchesFirebaseDatabaseWhere(row, input.where),
    );
    if (!current) return null;
    const updated = { ...current, ...input.update };
    snapshot.bundles.set(current.id, updated);
    return updated;
  },
  async delete(input): Promise<void> {
    if (input.model === "channels") {
      for (const row of snapshot.channels.values()) {
        if (matchesFirebaseDatabaseWhere(row, input.where)) {
          snapshot.channels.delete(row.id);
        }
      }
      return;
    }
    if (input.model === "bundle_patches") {
      for (const row of snapshot.bundlePatches.values()) {
        if (matchesFirebaseDatabaseWhere(row, input.where)) {
          snapshot.bundlePatches.delete(row.id);
        }
      }
      return;
    }
    if (input.model === "releases") {
      for (const row of snapshot.releases.values()) {
        if (matchesFirebaseDatabaseWhere<"releases">(row, input.where)) {
          snapshot.releases.delete(row.id);
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
      case "releases":
        return distinctCount(
          [...snapshot.releases.values()].filter((row) =>
            matchesFirebaseDatabaseWhere<"releases">(row, input.where),
          ),
          input.distinct as readonly string[] | undefined,
        );
      case "bundle_installations":
        return distinctCount(
          [...snapshot.bundleInstallations.values()].filter((row) =>
            matchesFirebaseDatabaseWhere<"bundle_installations">(
              row,
              input.where,
            ),
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
      case "api_keys":
        return (
          [...snapshot.apiKeys.values()].find((row) =>
            matchesFirebaseDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "channels":
        return (
          [...snapshot.channels.values()].find((row) =>
            matchesFirebaseDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "bundle_patches":
        return (
          [...snapshot.bundlePatches.values()].find((row) =>
            matchesFirebaseDatabaseWhere(row, input.where),
          ) ?? null
        );
      case "releases":
        return (
          [...snapshot.releases.values()].find((row) =>
            matchesFirebaseDatabaseWhere<"releases">(row, input.where),
          ) ?? null
        );
      case "release_catalogs":
        return (
          [...snapshot.releaseCatalogs.values()].find((row) =>
            matchesFirebaseDatabaseWhere<"release_catalogs">(row, input.where),
          ) ?? null
        );
      case "bundle_installations":
        return (
          [...snapshot.bundleInstallations.values()].find((row) =>
            matchesFirebaseDatabaseWhere<"bundle_installations">(
              row,
              input.where,
            ),
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
      case "bundle_installations":
        return queryFirebaseDatabaseRows<"bundle_installations">(
          [...snapshot.bundleInstallations.values()],
          input,
        );
      case "channels":
        return queryFirebaseDatabaseRows(
          [...snapshot.channels.values()],
          input,
        );
      case "api_keys":
        return queryFirebaseDatabaseRows([...snapshot.apiKeys.values()], input);
      case "releases":
        return queryFirebaseDatabaseRows<"releases">(
          [...snapshot.releases.values()],
          input,
        );
      case "release_catalogs":
        return queryFirebaseDatabaseRows<"release_catalogs">(
          [...snapshot.releaseCatalogs.values()],
          input,
        );
    }
  },
});
