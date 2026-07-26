import type {
  DatabaseCapabilityRuntime,
  DatabasePlugin,
  HotUpdaterInfrastructureRuntime,
  RuntimeStorageAccess,
  StorageInvocationToken,
  TransactionDatabasePlugin,
} from "@hot-updater/plugin-core";

import {
  createStorageCallContext,
  createStorageAccess,
  type RuntimeStorageEntry,
} from "../storageAccess";
import type { ResolvedStorageInvocation } from "../storageInvocation";

export type CreateGuardedInfrastructureRuntimeOptions<TContext> = {
  readonly beforeDatabaseOperation?: () => Promise<void>;
  readonly database: DatabasePlugin;
  readonly resolveStorageInvocation?: (
    token: StorageInvocationToken,
  ) => ResolvedStorageInvocation<TContext>;
  readonly storages: readonly RuntimeStorageEntry<TContext>[];
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
  const storage = createStorageAccess(options.storages);
  const resolve = options.resolveStorageInvocation;
  const storages = [...storage.records.values()].map((record) => {
    const access: RuntimeStorageAccess = {
      async getDownloadUrl(storageUri, token) {
        if (resolve === undefined) {
          throw new TypeError("Storage invocation authority is unavailable.");
        }
        const invocation = resolve(token);
        const fileUrl = await storage.resolveFileUrl(
          storageUri,
          createStorageCallContext(
            invocation.platformContext,
            invocation.storageContext,
          ),
        );
        if (fileUrl === null) {
          throw new Error("Storage plugin returned empty fileUrl");
        }
        return { fileUrl };
      },
      name: record.plugin.name,
      async readText(storageUri, token) {
        if (resolve === undefined) {
          throw new TypeError("Storage invocation authority is unavailable.");
        }
        const invocation = resolve(token);
        return storage.readStorageText(
          storageUri,
          createStorageCallContext(
            invocation.platformContext,
            invocation.storageContext,
          ),
        );
      },
      supportedProtocol: record.protocol,
    };
    return Object.freeze(access);
  });
  return Object.freeze({
    database: createGuardedDatabase(options.database, beforeOperation),
    storages: Object.freeze(storages),
  });
};
