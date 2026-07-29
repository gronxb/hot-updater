import type {
  DatabaseCapabilityRuntime,
  DatabasePlugin,
  HotUpdaterInfrastructureRuntime,
  TransactionDatabasePlugin,
} from "@hot-updater/plugin-core";

import type { RuntimeStorageRecord } from "../storageAccess";

export type CreateGuardedInfrastructureRuntimeOptions<TContext> = {
  readonly beforeDatabaseOperation?: () => Promise<void>;
  readonly database: DatabasePlugin;
  readonly storages: readonly RuntimeStorageRecord<TContext>[];
};

const createGuardedOperations = (
  database: TransactionDatabasePlugin,
  beforeOperation: () => Promise<void>,
): TransactionDatabasePlugin => {
  const operations: TransactionDatabasePlugin = {
    async count(input) {
      await beforeOperation();
      return database.count(input);
    },
    async create(input) {
      await beforeOperation();
      return database.create(input);
    },
    async delete(input) {
      await beforeOperation();
      return database.delete(input);
    },
    async findMany(input) {
      await beforeOperation();
      return database.findMany(input);
    },
    async findOne(input) {
      await beforeOperation();
      return database.findOne(input);
    },
    async update(input) {
      await beforeOperation();
      return database.update(input);
    },
  };
  return Object.freeze(operations);
};

const createGuardedDatabase = (
  database: DatabasePlugin,
  beforeOperation: () => Promise<void>,
): DatabaseCapabilityRuntime => {
  const transaction = database.transaction;
  const runtime: DatabaseCapabilityRuntime = {
    ...createGuardedOperations(database, beforeOperation),
    name: database.name,
    ...(transaction === undefined
      ? {}
      : {
          async transaction(callback) {
            await beforeOperation();
            return transaction((databaseTransaction) =>
              callback(
                createGuardedOperations(databaseTransaction, beforeOperation),
              ),
            );
          },
        }),
  };
  return Object.freeze(runtime);
};

export const createGuardedInfrastructureRuntime = <TContext = unknown>(
  options: CreateGuardedInfrastructureRuntimeOptions<TContext>,
): HotUpdaterInfrastructureRuntime<TContext> => {
  const beforeOperation =
    options.beforeDatabaseOperation ?? (async () => undefined);
  return Object.freeze({
    database: createGuardedDatabase(options.database, beforeOperation),
    storages: options.storages,
  });
};
