import {
  createDatabasePlugin,
  type CreateDatabaseImplementationInput,
  type DatabaseModel,
  type DatabaseModelMap,
  type DatabasePlugin,
  type DatabasePluginImplementation,
  resolveUpdateInfoFromBundles,
  rowsToBundles,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";

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
  channels: { rows: [] },
});

const assertReferences = (
  tables: Tables,
  input: CreateDatabaseImplementationInput,
): void => {
  switch (input.model) {
    case "bundles":
      if (
        !tables.channels.rows.some(({ id }) => id === input.data.channel_id)
      ) {
        throw new MemoryConstraintError("Bundle channel does not exist");
      }
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
    case "channels":
      return;
  }
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
      case "bundle_patches":
        if (tables.bundle_patches.rows.some(({ id }) => id === input.data.id))
          break;
        tables.bundle_patches.rows.push(structuredClone(input.data));
        return input.data;
      case "channels":
        if (
          tables.channels.rows.some(
            ({ id, name }) => id === input.data.id || name === input.data.name,
          )
        )
          break;
        tables.channels.rows.push(structuredClone(input.data));
        return input.data;
    }
    throw new MemoryConstraintError(`Duplicate ${input.model} id`);
  },
  update: async (input) => {
    const index = tables.bundles.rows.findIndex((row) =>
      matchesAll(row, input.where),
    );
    const current = tables.bundles.rows[index];
    if (current === undefined) return null;
    const updated = { ...current, ...input.update };
    if (!tables.channels.rows.some(({ id }) => id === updated.channel_id)) {
      throw new MemoryConstraintError("Bundle channel does not exist");
    }
    tables.bundles.rows[index] = updated;
    return structuredClone(updated);
  },
  delete: async (input) => {
    switch (input.model) {
      case "bundles":
        tables.bundles.rows = tables.bundles.rows.filter(
          (row) => !matchesAll(row, input.where),
        );
        return;
      case "bundle_patches":
        tables.bundle_patches.rows = tables.bundle_patches.rows.filter(
          (row) => !matchesAll(row, input.where),
        );
        return;
    }
  },
  count: async (input) =>
    tables.bundles.rows.filter((row) => matchesAll(row, input.where)).length,
  findOne: async (input) => {
    switch (input.model) {
      case "bundles":
        return (
          tables.bundles.rows.find((row) => matchesAll(row, input.where)) ??
          null
        );
      case "channels":
        return (
          tables.channels.rows.find((row) => matchesAll(row, input.where)) ??
          null
        );
    }
  },
  findMany: async (input) => {
    switch (input.model) {
      case "bundles":
        return queryRows(
          tables.bundles.rows,
          input.where,
          input.sortBy,
          input.offset,
          input.limit,
        );
      case "bundle_patches":
        return queryRows(
          tables.bundle_patches.rows,
          input.where,
          input.sortBy,
          input.offset,
          input.limit,
        );
      case "channels":
        return queryRows(
          tables.channels.rows,
          input.where,
          input.sortBy,
          input.offset,
          input.limit,
        );
    }
  },
});

const createImplementation = (
  tables: Tables,
): DatabasePluginImplementation => ({
  ...createCrudImplementation(tables),
  getUpdateInfo: async (args) =>
    resolveUpdateInfoFromBundles({
      args,
      bundles: rowsToBundles(
        tables.bundles.rows,
        tables.bundle_patches.rows,
        tables.bundles.rows,
        tables.channels.rows,
      ),
    }),
  transaction: async (callback) => {
    const transactionTables = structuredClone(tables);
    const result = await callback(createCrudImplementation(transactionTables));
    tables.bundles.rows = transactionTables.bundles.rows;
    tables.bundle_patches.rows = transactionTables.bundle_patches.rows;
    tables.channels.rows = transactionTables.channels.rows;
    return result;
  },
});

export const createInMemoryDatabaseAdapter = (
  tables: Tables = createTables(),
): DatabasePlugin =>
  createDatabasePlugin<void>({
    name: "in-memory-v2",
    factory: () => createImplementation(tables),
  })(undefined);

export const createInMemoryDatabaseHarness = () => {
  const tables = createTables();
  return {
    adapter: createInMemoryDatabaseAdapter(tables),
    reset: (): void => {
      tables.bundles.rows = [];
      tables.bundle_patches.rows = [];
      tables.channels.rows = [];
    },
  };
};
