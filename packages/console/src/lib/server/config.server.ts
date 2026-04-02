import { type ConfigResponse, loadConfig } from "@hot-updater/cli-tools";
import type { DatabasePlugin, StoragePlugin } from "@hot-updater/plugin-core";

let configPromise: Promise<{
  config: ConfigResponse;
  databasePlugin: DatabasePlugin;
  storagePlugin: StoragePlugin;
}> | null = null;

export const prepareConfig = async () => {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const config = await loadConfig(null);
        const databasePlugin = await config.database();
        const storagePlugin = await config.storage();
        if (!databasePlugin) {
          throw new Error("Database plugin initialization failed");
        }
        if (!storagePlugin) {
          throw new Error("Storage plugin initialization failed");
        }
        return { config, databasePlugin, storagePlugin };
      } catch (error) {
        console.error("Error during configuration initialization:", error);
        throw error;
      }
    })();
  }
  return configPromise;
};

export const isConfigLoaded = () => !!configPromise;
