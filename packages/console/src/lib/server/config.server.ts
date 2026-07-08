import type { ConfigInput, StoragePlugin } from "@hot-updater/plugin-core";

type ConsoleServerConfig = Pick<
  ConfigInput,
  "console" | "database" | "storage"
>;
type ConsoleConfigLoader = () =>
  | ConsoleServerConfig
  | Promise<ConsoleServerConfig>;

let configPromise: Promise<ConsoleServerConfig> | null = null;
let configLoader: ConsoleConfigLoader | null = null;
let storagePluginPromise: Promise<StoragePlugin> | null = null;

export const setConsoleConfigLoader = (loader: ConsoleConfigLoader) => {
  configLoader = loader;
  configPromise = null;
  storagePluginPromise = null;
};

const getGlobalConfigLoader = () => {
  const globalScope = globalThis as typeof globalThis & {
    __HOT_UPDATER_CONSOLE_CONFIG_LOADER__?: ConsoleConfigLoader;
  };

  return globalScope.__HOT_UPDATER_CONSOLE_CONFIG_LOADER__ ?? null;
};

const loadCachedConfig = async () => {
  if (!configPromise) {
    const load = configLoader ?? getGlobalConfigLoader();
    if (!load) {
      throw new Error(
        "Hot Updater Console config loader is not registered. Call setConsoleConfigLoader before using server APIs.",
      );
    }

    configPromise = Promise.resolve(load()).catch((error) => {
      configPromise = null;
      throw error;
    });
  }

  return configPromise;
};

const loadCachedStoragePlugin = async (config: ConsoleServerConfig) => {
  if (!storagePluginPromise) {
    storagePluginPromise = Promise.resolve(config.storage())
      .then((storagePlugin) => {
        if (!storagePlugin) {
          throw new Error("Storage plugin initialization failed");
        }

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
