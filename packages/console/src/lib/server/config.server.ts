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
  readonly authorityId: string;
  readonly console: NonNullable<HotUpdaterConsoleConfig["console"]>;
};

let configPromise: Promise<ResolvedConsoleConfig> | null = null;
let databaseClient: DatabaseClient | null = null;
let hotUpdater: ReturnType<
  typeof import("./runtime.server").createRuntimeHotUpdater
> | null = null;
let clientAccessKeyStore: ReturnType<
  typeof import("./runtime.server").createClientAccessKeyStore
> | null = null;
let clientAccessKeyStoreResolved = false;
let storagePluginPromise: Promise<
  StoragePluginWith<"get" | "put" | "exists" | "delete">
> | null = null;

const loadCachedConfig = async (request: Request) => {
  if (!configPromise) {
    configPromise = resolveConsoleConfig(request)
      .then((config) => ({
        ...config,
        authorityId: config.authorityId ?? "default",
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
