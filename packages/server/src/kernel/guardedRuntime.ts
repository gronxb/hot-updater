import type {
  BundlePatchTable,
  BundleTable,
  DatabaseCapabilityRuntime,
  DatabasePlugin,
  HotUpdaterInfrastructureRuntime,
  RuntimeStorageAccess,
  RuntimeStoragePlugin,
  UniversalComponentDataAdapter,
  UniversalComponentDataSource,
} from "@hot-updater/plugin-core";

export type CreateGuardedInfrastructureRuntimeOptions<TContext> = {
  readonly beforeDatabaseOperation?: () => Promise<void>;
  readonly database: DatabasePlugin;
  readonly storages: readonly RuntimeStoragePlugin<TContext>[];
};

function createGuardedComponentData(
  adapter: UniversalComponentDataAdapter,
  beforeOperation: () => Promise<void>,
): UniversalComponentDataAdapter {
  const artifacts = adapter.artifacts;
  const migrate = adapter.migrate;
  const runtime: UniversalComponentDataAdapter = {
    ...(artifacts === undefined
      ? {}
      : { artifacts: (schema) => artifacts(schema) }),
    bind(schema) {
      const source = adapter.bind(schema);
      const guarded: UniversalComponentDataSource = {
        async append(input) {
          await beforeOperation();
          return source.append(input);
        },
        async assertReady() {
          await beforeOperation();
          return source.assertReady();
        },
        async create(input) {
          await beforeOperation();
          return source.create(input);
        },
        async get(input) {
          await beforeOperation();
          return source.get(input);
        },
        async orderedScan(input) {
          await beforeOperation();
          return source.orderedScan(input);
        },
        schema: source.schema,
      };
      return Object.freeze(guarded);
    },
    ...(migrate === undefined
      ? {}
      : {
          async migrate(schema) {
            await beforeOperation();
            return migrate(schema);
          },
        }),
  };
  return Object.freeze(runtime);
}

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
    ...(database.componentData === undefined
      ? {}
      : {
          componentData: createGuardedComponentData(
            database.componentData,
            beforeOperation,
          ),
        }),
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
