import type {
  BundlePatchTable,
  BundleTable,
  DatabaseCapabilityRuntime,
  DatabasePlugin,
  HotUpdaterInfrastructureRuntime,
  RuntimeStorageAccess,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";

export type CreateGuardedInfrastructureRuntimeOptions<TContext> = {
  readonly beforeDatabaseOperation?: () => Promise<void>;
  readonly database: DatabasePlugin;
  readonly storages: readonly RuntimeStoragePlugin<TContext>[];
};

function createGuardedDatabase(
  database: DatabasePlugin,
  beforeOperation: () => Promise<void>,
): DatabaseCapabilityRuntime {
  const bundlePatches: BundlePatchTable = {
    async findByBundleIds(bundleIds) {
      await beforeOperation();
      return database.bundlePatches.findByBundleIds(bundleIds);
    },
  };
  const bundles: BundleTable = {
    async count(where) {
      await beforeOperation();
      return database.bundles.count(where);
    },
    async findById(id) {
      await beforeOperation();
      return database.bundles.findById(id);
    },
    async findMany(query) {
      await beforeOperation();
      return database.bundles.findMany(query);
    },
  };
  const runtime: DatabaseCapabilityRuntime = {
    bundlePatches: Object.freeze(bundlePatches),
    bundles: Object.freeze(bundles),
    async commit(input) {
      await beforeOperation();
      return database.commit(input);
    },
    name: database.name,
    ...(database.commitBatch === undefined
      ? {}
      : {
          async commitBatch(inputs) {
            await beforeOperation();
            return database.commitBatch?.(inputs) ?? [];
          },
        }),
    ...(database.getChannels === undefined
      ? {}
      : {
          async getChannels() {
            await beforeOperation();
            return database.getChannels?.() ?? [];
          },
        }),
    ...(database.getUpdateInfo === undefined
      ? {}
      : {
          async getUpdateInfo(args) {
            await beforeOperation();
            return database.getUpdateInfo?.(args) ?? null;
          },
        }),
  };
  return Object.freeze(runtime);
}

function createStorageAccess<TContext>(
  storage: RuntimeStoragePlugin<TContext>,
): RuntimeStorageAccess<TContext> {
  const access: RuntimeStorageAccess<TContext> = {
    async getDownloadUrl(storageUri, context) {
      return storage.profiles.runtime.getDownloadUrl(storageUri, context);
    },
    name: storage.name,
    async readText(storageUri, context) {
      return storage.profiles.runtime.readText(storageUri, context);
    },
    supportedProtocol: storage.supportedProtocol,
  };
  return Object.freeze(access);
}

export const createGuardedInfrastructureRuntime = <TContext = unknown>(
  options: CreateGuardedInfrastructureRuntimeOptions<TContext>,
): HotUpdaterInfrastructureRuntime<TContext> => {
  const beforeOperation =
    options.beforeDatabaseOperation ?? (async () => undefined);
  return Object.freeze({
    database: createGuardedDatabase(options.database, beforeOperation),
    storages: Object.freeze(options.storages.map(createStorageAccess)),
  });
};
