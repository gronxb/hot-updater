import {
  createDatabasePlugin,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  type CreateDatabaseImplementationInput,
  type DatabasePluginImplementation,
  type DatabaseModel,
  type DatabaseModelMap,
  DatabaseRowReferencedError,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";

import { matchesAll, queryRows } from "./inMemoryDatabaseQuery";

type Table<TModel extends DatabaseModel> = {
  rows: DatabaseModelMap[TModel][];
};

type Tables = {
  [TModel in DatabaseModel]: Table<TModel>;
};

class MemoryConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryConstraintError";
  }
}

const createTables = (): Tables => ({
  bundles: { rows: [] },
  bundle_patches: { rows: [] },
  releases: { rows: [] },
  release_catalogs: { rows: [] },
  channels: { rows: [] },
  bundle_events: { rows: [] },
  api_keys: { rows: [] },
});

const assertReferences = (
  tables: Tables,
  input: CreateDatabaseImplementationInput,
): void => {
  switch (input.model) {
    case "bundles":
      return;
    case "releases":
      if (
        !tables.channels.rows.some(({ id }) => id === input.data.channel_id) ||
        (input.data.bundle_id !== null &&
          !tables.bundles.rows.some(
            ({ id, platform }) =>
              id === input.data.bundle_id && platform === input.data.platform,
          ))
      ) {
        throw new MemoryConstraintError("Release reference does not exist");
      }
      return;
    case "release_catalogs":
      if (
        !tables.channels.rows.some(({ id }) => id === input.data.channel_id)
      ) {
        throw new MemoryConstraintError("Catalog channel does not exist");
      }
      return;
    case "channels":
    case "bundle_events":
    case "api_keys":
      return;
    case "bundle_patches":
      if (
        !tables.bundles.rows.some(({ id }) => id === input.data.bundle_id) ||
        !tables.bundles.rows.some(({ id }) => id === input.data.base_bundle_id)
      ) {
        throw new MemoryConstraintError(
          "Patch bundle reference does not exist",
        );
      }
      return;
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

const createCrudImplementation = (
  tables: Tables,
): TransactionDatabasePluginImplementation => ({
  create: async (input) => {
    assertReferences(tables, input);
    switch (input.model) {
      case "bundles":
        if (tables.bundles.rows.some(({ id }) => id === input.data.id)) break;
        tables.bundles.rows.push(structuredClone(input.data));
        return input.data;
      case "channels": {
        const existing = tables.channels.rows.find(
          ({ id, name }) => id === input.data.id || name === input.data.name,
        );
        if (existing !== undefined && input.onConflict === "ignore") {
          return existing;
        }
        if (existing !== undefined) break;
        tables.channels.rows.push(structuredClone(input.data));
        return input.data;
      }
      case "bundle_patches":
        if (tables.bundle_patches.rows.some(({ id }) => id === input.data.id))
          break;
        tables.bundle_patches.rows.push(structuredClone(input.data));
        return input.data;
      case "bundle_events":
        if (tables.bundle_events.rows.some(({ id }) => id === input.data.id))
          break;
        tables.bundle_events.rows.push(structuredClone(input.data));
        return input.data;
      case "releases":
        if (tables.releases.rows.some(({ id }) => id === input.data.id)) break;
        tables.releases.rows.push(structuredClone(input.data));
        return input.data;
      case "release_catalogs":
        if (
          tables.release_catalogs.rows.some(
            ({ scope_key }) => scope_key === input.data.scope_key,
          )
        ) {
          break;
        }
        tables.release_catalogs.rows.push(structuredClone(input.data));
        return input.data;
      case "api_keys":
        {
          const existing = tables.api_keys.rows.find(
            ({ id, hash }) => id === input.data.id || hash === input.data.hash,
          );
          if (existing !== undefined && input.onConflict === "ignore") {
            return existing;
          }
          if (existing !== undefined) break;
        }
        tables.api_keys.rows.push(structuredClone(input.data));
        return input.data;
    }
    throw new MemoryConstraintError(`Duplicate ${input.model} id`);
  },
  update: async (input) => {
    if (input.model === "api_keys") {
      const index = tables.api_keys.rows.findIndex((row) =>
        matchesAll(row, input.where),
      );
      const current = tables.api_keys.rows[index];
      if (current === undefined) return null;
      const updated = { ...current, ...input.update };
      tables.api_keys.rows[index] = updated;
      return structuredClone(updated);
    }
    if (input.model === "releases") {
      const index = tables.releases.rows.findIndex((row) =>
        matchesAll(row, input.where),
      );
      const current = tables.releases.rows[index];
      if (current === undefined) return null;
      const updated = { ...current, ...input.update };
      tables.releases.rows[index] = updated;
      return structuredClone(updated);
    }
    if (input.model === "release_catalogs") {
      const index = tables.release_catalogs.rows.findIndex((row) =>
        matchesAll(row, input.where),
      );
      const current = tables.release_catalogs.rows[index];
      if (current === undefined) return null;
      const updated = { ...current, ...input.update };
      tables.release_catalogs.rows[index] = updated;
      return structuredClone(updated);
    }
    const index = tables.bundles.rows.findIndex((row) =>
      matchesAll(row, input.where),
    );
    const current = tables.bundles.rows[index];
    if (current === undefined) return null;
    const updated = { ...current, ...input.update };
    tables.bundles.rows[index] = updated;
    return structuredClone(updated);
  },
  delete: async (input) => {
    switch (input.model) {
      case "bundles": {
        const removedIds = new Set(
          tables.bundles.rows
            .filter((row) => matchesAll(row, input.where))
            .map(({ id }) => id),
        );
        if (
          tables.releases.rows.some(
            ({ bundle_id }) => bundle_id !== null && removedIds.has(bundle_id),
          )
        ) {
          throw new DatabaseRowReferencedError();
        }
        tables.bundles.rows = tables.bundles.rows.filter(
          ({ id }) => !removedIds.has(id),
        );
        tables.bundle_patches.rows = tables.bundle_patches.rows.filter(
          (row) =>
            !removedIds.has(row.bundle_id) &&
            !removedIds.has(row.base_bundle_id),
        );
        return;
      }
      case "bundle_patches":
        tables.bundle_patches.rows = tables.bundle_patches.rows.filter(
          (row) => !matchesAll(row, input.where),
        );
        return;
      case "releases":
        tables.releases.rows = tables.releases.rows.filter(
          (row) => !matchesAll(row, input.where),
        );
        return;
      case "channels": {
        const selectedIds = new Set(
          tables.channels.rows
            .filter((row) => matchesAll(row, input.where))
            .map(({ id }) => id),
        );
        if (
          tables.releases.rows.some(({ channel_id }) =>
            selectedIds.has(channel_id),
          )
        ) {
          throw new DatabaseRowReferencedError();
        }
        tables.channels.rows = tables.channels.rows.filter(
          ({ id }) => !selectedIds.has(id),
        );
        return;
      }
    }
  },
  count: async (input) => {
    switch (input.model) {
      case "bundles": {
        const rows = tables.bundles.rows.filter((row) =>
          matchesAll(row, input.where),
        );
        return distinctCount(
          rows,
          input.distinct as readonly string[] | undefined,
        );
      }
      case "bundle_patches": {
        const rows = tables.bundle_patches.rows.filter((row) =>
          matchesAll(row, input.where),
        );
        return distinctCount(
          rows,
          input.distinct as readonly string[] | undefined,
        );
      }
      case "releases": {
        const rows = tables.releases.rows.filter((row) =>
          matchesAll(row, input.where),
        );
        return distinctCount(
          rows,
          input.distinct as readonly string[] | undefined,
        );
      }
    }
  },
  findOne: async (input) => {
    switch (input.model) {
      case "bundles":
        return (
          tables.bundles.rows.find((row) => matchesAll(row, input.where)) ??
          null
        );
      case "bundle_patches":
        return (
          tables.bundle_patches.rows.find((row) =>
            matchesAll(row, input.where),
          ) ?? null
        );
      case "api_keys":
        return (
          tables.api_keys.rows.find((row) => matchesAll(row, input.where)) ??
          null
        );
      case "channels":
        return (
          tables.channels.rows.find((row) => matchesAll(row, input.where)) ??
          null
        );
      case "releases":
        return (
          tables.releases.rows.find((row) => matchesAll(row, input.where)) ??
          null
        );
      case "release_catalogs":
        return (
          tables.release_catalogs.rows.find((row) =>
            matchesAll(row, input.where),
          ) ?? null
        );
    }
  },
  findMany: async (input) => {
    switch (input.model) {
      case "bundles":
        return queryRows(
          tables.bundles.rows,
          input.where,
          input.orderBy,
          input.distinctOn,
          input.offset,
          input.limit,
        );
      case "bundle_patches":
        return queryRows(
          tables.bundle_patches.rows,
          input.where,
          input.orderBy,
          input.distinctOn,
          input.offset,
          input.limit,
        );
      case "bundle_events":
        return queryRows(
          tables.bundle_events.rows,
          input.where,
          input.orderBy,
          input.distinctOn,
          input.offset,
          input.limit,
        );
      case "channels":
        return queryRows(
          tables.channels.rows,
          input.where,
          input.orderBy,
          input.distinctOn,
          input.offset,
          input.limit,
        );
      case "api_keys":
        return queryRows(
          tables.api_keys.rows,
          input.where,
          input.orderBy,
          input.distinctOn,
          input.offset,
          input.limit,
        );
      case "releases":
        return queryRows(
          tables.releases.rows,
          input.where,
          input.orderBy,
          input.distinctOn,
          input.offset,
          input.limit,
        );
      case "release_catalogs":
        return queryRows(
          tables.release_catalogs.rows,
          input.where,
          input.orderBy,
          input.distinctOn,
          input.offset,
          input.limit,
        );
    }
  },
});

const createImplementation = (tables: Tables): DatabasePluginImplementation => {
  let mutationQueue: Promise<void> = Promise.resolve();
  const withMutationLock = <TResult>(
    operation: () => Promise<TResult> | TResult,
  ): Promise<TResult> => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    ...createCrudImplementation(tables),
    insertChannel: ({ row }) =>
      withMutationLock(() => {
        const existing = tables.channels.rows.find(
          ({ name }) => name === row.name,
        );
        if (existing !== undefined) {
          return { row: structuredClone(existing), inserted: false };
        }
        if (tables.channels.rows.some(({ id }) => id === row.id)) {
          throw new MemoryConstraintError("Duplicate channels id");
        }
        tables.channels.rows.push(structuredClone(row));
        return { row: structuredClone(row), inserted: true };
      }),
    deleteChannel: ({ id }) =>
      withMutationLock(() => {
        const index = tables.channels.rows.findIndex((row) => row.id === id);
        if (index === -1) {
          return { deleted: false, reason: "not_found" as const };
        }
        if (tables.releases.rows.some(({ channel_id }) => channel_id === id)) {
          return { deleted: false, reason: "not_empty" as const };
        }
        tables.channels.rows.splice(index, 1);
        return { deleted: true as const };
      }),
    transaction: (callback) =>
      withMutationLock(async () => {
        const transactionTables = structuredClone(tables);
        const result = await callback(
          createCrudImplementation(transactionTables),
        );
        tables.bundles.rows = transactionTables.bundles.rows;
        tables.bundle_patches.rows = transactionTables.bundle_patches.rows;
        tables.releases.rows = transactionTables.releases.rows;
        tables.release_catalogs.rows = transactionTables.release_catalogs.rows;
        tables.channels.rows = transactionTables.channels.rows;
        tables.bundle_events.rows = transactionTables.bundle_events.rows;
        tables.api_keys.rows = transactionTables.api_keys.rows;
        return result;
      }),
  };
};

export const createInMemoryDatabasePlugin = (
  tables: Tables = createTables(),
): DatabasePlugin => {
  const adapter = createDatabasePluginAdapter(
    "in-memory-v2",
    createImplementation(tables),
  );
  return createDatabasePlugin({
    name: "in-memory-v2",
    models: adapter.models,
    commit: adapter.commit,
  });
};

export const createInMemoryDatabaseHarness = () => {
  const tables = createTables();
  return {
    plugin: createInMemoryDatabasePlugin(tables),
    reset: (): void => {
      tables.bundles.rows = [];
      tables.bundle_patches.rows = [];
      tables.releases.rows = [];
      tables.release_catalogs.rows = [];
      tables.channels.rows = [];
      tables.bundle_events.rows = [];
      tables.api_keys.rows = [];
    },
  };
};
