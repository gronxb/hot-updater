import type {
  DatabasePlugin,
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";
import { assertRuntimeStoragePlugin } from "@hot-updater/plugin-core";

export * from "./createBundleDiff";
import { createHandler, type HandlerRoutes } from "../handler";
import { normalizeBasePath } from "../route";
import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import { createStorageAccess } from "../storageAccess";
import { createPluginDatabaseCore } from "./pluginCore";
import { generateSchemaFromHotUpdaterSchema } from "./schemaGenerators";
import {
  type DatabaseAdapterCapabilities,
  type DatabaseAdapter,
  type DatabaseAPI,
  type Migrator,
  type SchemaGenerator,
  isDatabasePluginFactory,
  type StoragePluginFactory,
} from "./types";

export type { Migrator, SchemaGenerator } from "./types";
export { HOT_UPDATER_SERVER_VERSION } from "../version";

export type HotUpdaterAPI<TContext = unknown> = DatabaseAPI<TContext> & {
  basePath: string;
  handler: (
    request: Request,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Response>;
  adapterName: string;
  createMigrator: () => Migrator;
  generateSchema: SchemaGenerator;
};

export interface CreateHotUpdaterOptions<TContext = unknown> {
  database: DatabaseAdapter<TContext>;
  /**
   * Storage plugins for handling file uploads and downloads.
   */
  storages?: (
    | RuntimeStoragePlugin<TContext>
    | StoragePluginFactory<TContext>
  )[];
  /**
   * @deprecated Use `storages` instead. This field will be removed in a future version.
   */
  storagePlugins?: (
    | RuntimeStoragePlugin<TContext>
    | StoragePluginFactory<TContext>
  )[];
  basePath?: string;
  cwd?: string;
  routes?: HandlerRoutes;
}

export class HotUpdaterSchemaMigrationRequiredError extends Error {
  constructor(
    readonly adapterName: string,
    readonly currentVersion: string | undefined,
  ) {
    super(
      currentVersion === undefined
        ? `Hot Updater database schema is not initialized for ${adapterName}. Run \`hot-updater db migrate\` before using this adapter.`
        : `Hot Updater database schema version ${currentVersion} is not supported by ${adapterName}. Run \`hot-updater db migrate\` to upgrade to ${HOT_UPDATER_SCHEMA_VERSION}.`,
    );
    this.name = "HotUpdaterSchemaMigrationRequiredError";
  }
}

const createSchemaReadinessChecker = (
  adapterName: string,
  createMigrator: (() => Migrator) | undefined,
): (() => Promise<void>) => {
  if (!createMigrator) return async () => {};

  let ready = false;
  return async () => {
    if (ready) return;
    const version = await createMigrator().getVersion();
    if (version !== HOT_UPDATER_SCHEMA_VERSION) {
      throw new HotUpdaterSchemaMigrationRequiredError(adapterName, version);
    }
    ready = true;
  };
};

export function createHotUpdater<TContext = unknown>(
  options: CreateHotUpdaterOptions<TContext>,
): HotUpdaterAPI<TContext> {
  const basePath = normalizeBasePath(options.basePath ?? "/api");

  // Initialize storage plugins - call factories if they are functions
  const storagePlugins = (options.storages ?? options.storagePlugins ?? []).map(
    (plugin) => {
      const storagePlugin = typeof plugin === "function" ? plugin() : plugin;
      assertRuntimeStoragePlugin(storagePlugin);
      return storagePlugin;
    },
  );
  const { readStorageText, resolveFileUrl } =
    createStorageAccess(storagePlugins);

  const database = options.database;

  const capabilities = database as DatabaseAdapterCapabilities;
  const plugin: DatabasePlugin<TContext> = isDatabasePluginFactory(database)
    ? database()
    : database;
  const adapterName = capabilities.adapterName ?? plugin.name;
  const assertSchemaReady = createSchemaReadinessChecker(
    adapterName,
    capabilities.createMigrator,
  );
  const core = createPluginDatabaseCore<TContext>(
    () => plugin,
    resolveFileUrl,
    isDatabasePluginFactory(database)
      ? {
          createMutationPlugin: () => database(),
          beforeOperation: assertSchemaReady,
          readStorageText,
        }
      : { beforeOperation: assertSchemaReady, readStorageText },
  );

  const generateSchema = capabilities.generateSchema ?? core.generateSchema;
  const api = {
    basePath,
    adapterName: capabilities.adapterName ?? core.adapterName,
    createMigrator: capabilities.createMigrator ?? core.createMigrator,
    generateSchema: (...args: Parameters<SchemaGenerator>) =>
      generateSchemaFromHotUpdaterSchema(
        api.adapterName,
        capabilities.provider,
        args[0],
        generateSchema(...args),
      ),
    handler: createHandler(core.api, {
      basePath,
      routes: options.routes,
    }),
  };
  Object.defineProperties(api, Object.getOwnPropertyDescriptors(core.api));
  return api as HotUpdaterAPI<TContext>;
}
