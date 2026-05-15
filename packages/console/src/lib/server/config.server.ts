import { type ConfigResponse, loadConfig } from "@hot-updater/cli-tools";
import {
  assertNodeStoragePlugin,
  type NodeStoragePlugin,
} from "@hot-updater/plugin-core";

let configPromise: Promise<ConfigResponse> | null = null;
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
    const [databasePlugin, storagePlugin] = await Promise.all([
      config.database(),
      loadCachedStoragePlugin(config),
    ]);

    if (!databasePlugin) {
      throw new Error("Database plugin initialization failed");
    }

    return { config, databasePlugin, storagePlugin };
  } catch (error) {
    console.error("Error during configuration initialization:", error);
    throw error;
  }
};

export const isConfigLoaded = () => Boolean(configPromise);
