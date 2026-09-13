import {
  assertStorageOperations,
  createDatabaseClient,
  type DatabaseClient,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";
import { getRequest } from "@tanstack/react-start/server";

import type { HotUpdaterConsoleConfig } from "../../index";
import { requireConsoleAccess } from "./auth.server";
import { resolveConsoleConfig } from "./console-runtime.server";

type ResolvedConsoleConfig = HotUpdaterConsoleConfig & {
  readonly console: NonNullable<HotUpdaterConsoleConfig["console"]>;
};

let configPromise: Promise<ResolvedConsoleConfig> | null = null;
let databaseClient: DatabaseClient | null = null;
let hotUpdater: ReturnType<
  typeof import("./runtime.server").createRuntimeHotUpdater
> | null = null;
let apiKeyStore: ReturnType<
  typeof import("./runtime.server").createApiKeyStore
> | null = null;
let apiKeyStoreResolved = false;
let storagePluginPromise: Promise<
  StoragePluginWith<"get" | "put" | "exists" | "delete">
> | null = null;

const loadCachedConfig = async (request: Request) => {
  if (!configPromise) {
    configPromise = resolveConsoleConfig(request)
      .then((config) => ({
        ...config,
        console: config.console ?? {},
      }))
      .catch((error) => {
        configPromise = null;
        throw error;
      });
  }

  return configPromise;
};

const loadCachedStoragePlugin = async (config: ResolvedConsoleConfig) => {
  if (!storagePluginPromise) {
    storagePluginPromise = Promise.resolve(config.storage)
      .then((storagePlugin) => {
        assertStorageOperations(storagePlugin, [
          "get",
          "put",
          "exists",
          "delete",
        ]);
        return storagePlugin;
      })
      .catch((error) => {
        storagePluginPromise = null;
        throw error;
      });
  }

  return storagePluginPromise;
};

export const prepareConfig = async (request: Request = getRequest()) => {
  try {
    await requireConsoleAccess(request);
    const config = await loadCachedConfig(request);

    if (!databaseClient) {
      databaseClient = createDatabaseClient(config.database);
    }

    if (!hotUpdater) {
      const { createRuntimeHotUpdater } = await import("./runtime.server");
      hotUpdater = createRuntimeHotUpdater(config);
    }

    if (!apiKeyStoreResolved) {
      const { createApiKeyStore } = await import("./runtime.server");
      apiKeyStore = createApiKeyStore(config);
      apiKeyStoreResolved = true;
    }

    const storagePlugin = await loadCachedStoragePlugin(config);

    return {
      config,
      databaseClient,
      hotUpdater,
      apiKeyStore,
      storagePlugin,
    };
  } catch (error) {
    if (
      !(
        error instanceof Response &&
        (error.status === 401 || error.status === 403)
      )
    ) {
      console.error("Error during configuration initialization:", error);
    }
    throw error;
  }
};

export const isConfigLoaded = () => Boolean(configPromise);
