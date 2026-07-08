import {
  assertStorageGetDownloadUrl,
  type Bundle,
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
export type HotUpdaterConsolePlatform = "ios" | "android";
export type HotUpdaterConsoleBundle = {
  id: string;
  platform: HotUpdaterConsolePlatform;
  shouldForceUpdate: boolean;
  enabled: boolean;
  fileHash: string;
  storageUri: string;
  gitCommitHash: string | null;
  message: string | null;
  channel: string;
  targetAppVersion: string | null;
  fingerprintHash: string | null;
  metadata?: {
    app_version?: string;
  };
  manifestStorageUri?: string | null;
  manifestFileHash?: string | null;
  assetBaseStorageUri?: string | null;
  patches?:
    | {
        baseBundleId: string;
        baseFileHash: string;
        patchFileHash: string;
        patchStorageUri: string;
      }[]
    | null;
  patchBaseBundleId?: string | null;
  patchBaseFileHash?: string | null;
  patchFileHash?: string | null;
  patchStorageUri?: string | null;
  rolloutCohortCount?: number | null;
  targetCohorts?: string[] | null;
};
export type HotUpdaterConsolePagination = {
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  currentPage: number;
  totalPages: number;
  nextCursor?: string | null;
  previousCursor?: string | null;
};
export type HotUpdaterConsoleDatabasePlugin = {
  getChannels: (context?: unknown) => Promise<string[]>;
  getBundleById: (
    bundleId: string,
    context?: unknown,
  ) => Promise<HotUpdaterConsoleBundle | null>;
  getBundles: (
    options: {
      where?: {
        channel?: string;
        platform?: HotUpdaterConsolePlatform;
        enabled?: boolean;
        id?: {
          eq?: string;
          gt?: string;
          gte?: string;
          lt?: string;
          lte?: string;
          in?: string[];
        };
        targetAppVersion?: string | null;
        targetAppVersionIn?: string[];
        targetAppVersionNotNull?: boolean;
        fingerprintHash?: string | null;
      };
      limit: number;
      page?: number;
      cursor?: {
        after?: string;
        before?: string;
      };
      orderBy?: {
        field: "id";
        direction: "asc" | "desc";
      };
    },
    context?: unknown,
  ) => Promise<{
    data: HotUpdaterConsoleBundle[];
    pagination: HotUpdaterConsolePagination;
  }>;
  updateBundle: (
    targetBundleId: string,
    newBundle: Partial<HotUpdaterConsoleBundle>,
    context?: unknown,
  ) => Promise<void>;
  appendBundle: (
    insertBundle: HotUpdaterConsoleBundle,
    context?: unknown,
  ) => Promise<void>;
  commitBundle: (context?: unknown) => Promise<void>;
  onUnmount?: () => Promise<void>;
  name: string;
  deleteBundle: (
    deleteBundle: HotUpdaterConsoleBundle,
    context?: unknown,
  ) => Promise<void>;
};
export type HotUpdaterConsoleStoragePlugin = {
  upload?: (
    key: string,
    source:
      | {
          kind: "file";
          filePath: string;
        }
      | {
          kind: "bytes";
          data: ArrayBuffer | Uint8Array | string;
          contentType?: string;
        },
    context?: unknown,
  ) => Promise<{ storageUri: string }>;
  exists?: (storageUri: string, context?: unknown) => Promise<boolean>;
  delete?: (storageUri: string, context?: unknown) => Promise<void>;
  getDownloadUrl?: (
    storageUri: string,
    context?: unknown,
  ) => Promise<{ fileUrl: string }>;
  readText?: (storageUri: string, context?: unknown) => Promise<string | null>;
  readBytes?: (
    storageUri: string,
    context?: unknown,
  ) => Promise<ArrayBuffer | Uint8Array | null>;
  supportedProtocol: string;
  name: string;
};
export type HotUpdaterConsoleConfig = {
  console?: {
    gitUrl?: string;
    port?: number;
    [key: string]: unknown;
  };
  database: () =>
    | Promise<HotUpdaterConsoleDatabasePlugin>
    | HotUpdaterConsoleDatabasePlugin;
  storage: () =>
    | Promise<HotUpdaterConsoleStoragePlugin>
    | HotUpdaterConsoleStoragePlugin;
};

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
