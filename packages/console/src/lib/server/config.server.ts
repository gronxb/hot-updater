import type { HotUpdaterCoreApi } from "@hot-updater/plugin-core";
import { createDatabaseCoreApi } from "@hot-updater/server/db";
import { getRequest } from "@tanstack/react-start/server";

import { requireConsoleAccess } from "./auth.server";
import {
  resolveConsoleConfig,
  type ResolvedConsoleConfig,
} from "./console-runtime.server";
import type { ConsoleRuntime } from "./runtime.server";

let configPromise: Promise<ResolvedConsoleConfig> | null = null;
let core: HotUpdaterCoreApi | null = null;
let runtime: ConsoleRuntime | null = null;

const loadCachedConfig = async (request: Request) => {
  if (!configPromise) {
    configPromise = resolveConsoleConfig(request).catch((error) => {
      configPromise = null;
      throw error;
    });
  }

  return configPromise;
};

export const prepareConfig = async (request: Request = getRequest()) => {
  try {
    await requireConsoleAccess(request);
    const config = await loadCachedConfig(request);

    // Bundles, releases, catalogs, and channels: core's API, in process or
    // over a self-hosted server's admin API.
    core ??= createDatabaseCoreApi(config.database);

    // The console's features: those of the plugins the server runs.
    if (!runtime) {
      const { createConsoleRuntime } = await import("./runtime.server");
      runtime = createConsoleRuntime(config);
    }

    // Each bundle file is read and deleted with its protocol's storage.
    return { config, core, runtime, storage: config.storage };
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
