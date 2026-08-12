import { type ConfigResponse, loadConfig } from "@hot-updater/cli-tools";
import {
  assertStorageOperations,
  createDatabaseClient,
  type DatabaseClient,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";

let configPromise: Promise<ConfigResponse> | null = null;
let databaseClient: DatabaseClient | null = null;
let hotUpdater: ReturnType<
  typeof import("./runtime.server").createRuntimeHotUpdater
> | null = null;
let clientAccessKeyStore: ReturnType<
  typeof import("./runtime.server").createClientAccessKeyStore
> | null = null;
let clientAccessKeyStoreResolved = false;
let storagePluginPromise: Promise<
  StoragePluginWith<"get" | "put" | "delete">
> | null = null;

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
    storagePluginPromise = Promise.resolve(config.storage)
      .then((storagePlugin) => {
        assertStorageOperations(storagePlugin, ["get", "put", "delete"]);
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

    if (!hotUpdater) {
      const { createRuntimeHotUpdater } = await import("./runtime.server");
      hotUpdater = createRuntimeHotUpdater(config);
    }

    if (!clientAccessKeyStoreResolved) {
      const { createClientAccessKeyStore } = await import("./runtime.server");
      clientAccessKeyStore = createClientAccessKeyStore(config);
      clientAccessKeyStoreResolved = true;
    }

    const storagePlugin = await loadCachedStoragePlugin(config);

    return {
      config,
      databaseClient,
      hotUpdater,
      clientAccessKeyStore,
      storagePlugin,
    };
  } catch (error) {
    console.error("Error during configuration initialization:", error);
    throw error;
  }
};

export const isConfigLoaded = () => Boolean(configPromise);
