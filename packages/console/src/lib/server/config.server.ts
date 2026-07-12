import { type ConfigResponse, loadConfig } from "@hot-updater/cli-tools";
import {
  assertNodeStoragePlugin,
  createDatabaseClient,
  type DatabaseClient,
  type NodeStoragePlugin,
} from "@hot-updater/plugin-core";

let configPromise: Promise<ConfigResponse> | null = null;
let databaseClient: DatabaseClient | null = null;
let storagePluginPromise: Promise<NodeStoragePlugin> | null = null;

const loadCachedConfig = async () => {
  if (!configPromise) {
    configPromise = loadConfig(null).catch((error) => {
      configPromise = null;
      throw error;
    });
  }

  return configPromise;
};

const loadCachedStoragePlugin = async (config: ConfigResponse) => {
  if (!storagePluginPromise) {
    storagePluginPromise = Promise.resolve(config.storage())
      .then((storagePlugin) => {
        if (!storagePlugin) {
          throw new Error("Storage plugin initialization failed");
        }

        assertNodeStoragePlugin(storagePlugin);
        return storagePlugin;
      })
      .catch((error) => {
        storagePluginPromise = null;
        throw error;
      });
  }

  return storagePluginPromise;
};

export const prepareConfig = async () => {
  try {
    const config = await loadCachedConfig();
    if (!databaseClient) {
      databaseClient = createDatabaseClient(config.database);
    }
    const storagePlugin = await loadCachedStoragePlugin(config);

    return { config, databaseClient, storagePlugin };
  } catch (error) {
    console.error("Error during configuration initialization:", error);
    throw error;
  }
};

export const isConfigLoaded = () => Boolean(configPromise);
