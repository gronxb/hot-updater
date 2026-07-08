import {
  assertStorageGetDownloadUrl,
  type Bundle,
  type ConfigInput,
  type DatabasePlugin,
  type StoragePlugin,
} from "@hot-updater/plugin-core";

import type { ConsoleApiClient } from "./lib/api-client";
import { DEFAULT_PAGE_LIMIT } from "./lib/constants";
import { deleteBundle as deleteBundleWithStorage } from "./lib/server/deleteBundle";
import {
  getBundleChildCounts as getBundleChildCountsWithConfig,
  getBundleChildren as getBundleChildrenWithConfig,
} from "./lib/server/getBundleChildren";
import { promoteBundle as promoteBundleWithStorage } from "./lib/server/promoteBundle";

const emptyBundleList = {
  data: [],
  pagination: {
    total: 0,
    hasNextPage: false,
    hasPreviousPage: false,
    currentPage: 1,
    totalPages: 0,
  },
};

const assertRemoteDownloadUrl = (fileUrl: string) => {
  try {
    const protocol = new URL(fileUrl).protocol.replace(":", "");
    if (protocol === "http" || protocol === "https") {
      return fileUrl;
    }
  } catch {}

  throw new Error(
    "Storage plugin returned a local file path; browser downloads require an HTTP(S) download URL.",
  );
};

export type HotUpdaterConsoleServerApi = ConsoleApiClient;
export type HotUpdaterConsoleConfig = Pick<
  ConfigInput,
  "console" | "database" | "storage"
>;

export function createHotUpdaterConsoleApi(
  config: HotUpdaterConsoleConfig,
): HotUpdaterConsoleServerApi {
  let databasePluginPromise: Promise<DatabasePlugin> | null = null;
  let storagePluginPromise: Promise<StoragePlugin> | null = null;

  const loadDatabasePlugin = async () => {
    if (!databasePluginPromise) {
      databasePluginPromise = Promise.resolve(config.database())
        .then((databasePlugin) => {
          if (!databasePlugin) {
            throw new Error("Database plugin initialization failed");
          }

          return databasePlugin;
        })
        .catch((error) => {
          databasePluginPromise = null;
          throw error;
        });
    }

    return databasePluginPromise;
  };

  const loadStoragePlugin = async () => {
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

  const prepareConfig = async () => {
    const [databasePlugin, storagePlugin] = await Promise.all([
      loadDatabasePlugin(),
      loadStoragePlugin(),
    ]);

    return { config, databasePlugin, storagePlugin };
  };

  return {
    createBundle: async (bundle) => {
      const { databasePlugin } = await prepareConfig();
      await databasePlugin.appendBundle(bundle);
      await databasePlugin.commitBundle();
      return { success: true, bundleId: bundle.id };
    },
    deleteBundle: async (input) => {
      const { databasePlugin, storagePlugin } = await prepareConfig();

      await deleteBundleWithStorage(input, {
        databasePlugin,
        storagePlugin,
        waitForStorageCleanup: false,
      });

      return { success: true };
    },
    getBundle: async ({ bundleId }) => {
      const { databasePlugin } = await prepareConfig();
      return (await databasePlugin.getBundleById(bundleId)) ?? null;
    },
    getBundleChildCounts: async ({ bundleIds }) => {
      const { databasePlugin } = await prepareConfig();
      return getBundleChildCountsWithConfig(bundleIds, { databasePlugin });
    },
    getBundleChildren: async (input) => {
      const { databasePlugin } = await prepareConfig();
      return getBundleChildrenWithConfig(input, { databasePlugin });
    },
    getBundleDownloadUrl: async ({ bundleId }) => {
      const { databasePlugin, storagePlugin } = await prepareConfig();
      const bundle = await databasePlugin.getBundleById(bundleId);

      if (!bundle) {
        throw new Error("Bundle not found");
      }

      const { storageUri } = bundle;
      if (!storageUri) {
        throw new Error("Bundle has no storage URI");
      }

      const url = new URL(storageUri);
      const protocol = url.protocol.replace(":", "");

      if (protocol === "http" || protocol === "https") {
        return { fileUrl: storageUri };
      }

      if (storagePlugin.supportedProtocol !== protocol) {
        throw new Error(`No storage plugin for protocol: ${protocol}`);
      }

      assertStorageGetDownloadUrl(storagePlugin);
      const downloadTarget = await storagePlugin.getDownloadUrl(storageUri);
      const { fileUrl } = downloadTarget;

      if (!fileUrl) {
        throw new Error("Storage plugin returned empty fileUrl");
      }

      return { fileUrl: assertRemoteDownloadUrl(fileUrl) };
    },
    getBundles: async (filters) => {
      const { databasePlugin } = await prepareConfig();
      const query = {
        channel: filters?.channel ?? undefined,
        platform: filters?.platform ?? undefined,
        page:
          typeof filters?.page === "number" &&
          Number.isInteger(filters.page) &&
          filters.page > 1
            ? filters.page
            : undefined,
        limit: filters?.limit ? Number(filters.limit) : DEFAULT_PAGE_LIMIT,
        after: filters?.after ?? undefined,
        before: filters?.before ?? undefined,
      };
      const bundleQueryOptions = {
        where: {
          channel: query.channel,
          platform: query.platform,
        },
        limit: query.limit,
        page: query.page,
        cursor:
          query.after || query.before
            ? {
                after: query.after,
                before: query.before,
              }
            : undefined,
      } as Parameters<typeof databasePlugin.getBundles>[0];

      return (
        (await databasePlugin.getBundles(bundleQueryOptions)) ?? emptyBundleList
      );
    },
    getChannels: async () => {
      const { databasePlugin } = await prepareConfig();
      return (await databasePlugin.getChannels()) ?? [];
    },
    getConfig: async () => ({ console: config.console }),
    getConfigLoaded: async () => ({ configLoaded: true }),
    promoteBundle: async (input) => {
      const { databasePlugin, storagePlugin } = await prepareConfig();
      const bundle = await promoteBundleWithStorage(input, {
        databasePlugin,
        storagePlugin,
      });

      return { success: true, bundle };
    },
    updateBundle: async ({ bundleId, bundle }) => {
      const { databasePlugin } = await prepareConfig();
      await databasePlugin.updateBundle(bundleId, bundle);
      await databasePlugin.commitBundle();
      const updatedBundle = await databasePlugin.getBundleById(bundleId);

      if (!updatedBundle) {
        throw new Error("Updated bundle not found");
      }

      return { success: true, bundle: updatedBundle };
    },
  };
}

export type { Bundle };
