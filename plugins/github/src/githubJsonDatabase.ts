import {
  createEngineDatabase,
  createKvAdapter,
  type EngineDatabase,
  migrateCoreSchema,
  type PluginTables,
} from "@hot-updater/plugin-core";

import {
  createGithubJsonStore,
  type GithubJsonStoreOptions,
} from "./githubJsonStore";

export type GithubJsonDatabaseConfig = GithubJsonStoreOptions;

const NAME = "githubJsonDatabase";

/**
 * Hot Updater's database as one JSON file in a GitHub repository,
 * `hot-updater/database.json` by default, through the storage engine.
 */
export const githubJsonDatabase = (
  config: GithubJsonDatabaseConfig,
): EngineDatabase =>
  createEngineDatabase({
    name: NAME,
    adapter: createKvAdapter({ store: createGithubJsonStore(config) }),
  });

/**
 * Creates the file when it is missing, then writes the settings rows of core
 * and of `plugins`, the plugins the server runs.
 */
export const migrateGithubJsonDatabase = (
  config: GithubJsonDatabaseConfig,
  plugins: readonly PluginTables[] = [],
): Promise<void> =>
  migrateCoreSchema(
    createKvAdapter({ store: createGithubJsonStore(config) }),
    NAME,
    plugins,
  );
