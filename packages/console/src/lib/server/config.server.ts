import {
  assertStorageOperations,
  type HotUpdaterCoreApi,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";
import { createDatabaseCoreApi } from "@hot-updater/server/db";
import { getRequest } from "@tanstack/react-start/server";

import type { HotUpdaterConsoleConfig } from "../../index";
import { requireConsoleAccess } from "./auth.server";
import { resolveConsoleConfig } from "./console-runtime.server";
import type { ConsoleRuntime } from "./runtime.server";

type ResolvedConsoleConfig = HotUpdaterConsoleConfig & {
  readonly console: NonNullable<HotUpdaterConsoleConfig["console"]>;
};

let configPromise: Promise<ResolvedConsoleConfig> | null = null;
let core: HotUpdaterCoreApi | null = null;
let runtime: ConsoleRuntime | null = null;
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

    // Bundles, releases, catalogs, and channels: core's API, in process or
    // over a self-hosted server's admin API.
    core ??= createDatabaseCoreApi(config.database);

    if (!runtime) {
      const { createConsoleRuntime } = await import("./runtime.server");
      runtime = createConsoleRuntime(config);
    }

    const storagePlugin = await loadCachedStoragePlugin(config);

    return {
      config,
      core,
      insights: runtime.insights,
      apiKeys: runtime.apiKeys,
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
