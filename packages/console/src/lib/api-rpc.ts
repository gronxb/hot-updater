import { isRuntimeStoragePlugin, type Bundle } from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/react-start";

import { DEFAULT_PAGE_LIMIT } from "./constants";

type GetBundlesInput = {
  channel?: string;
  platform?: "ios" | "android";
  page?: number;
  limit?: string;
  after?: string;
  before?: string;
};

type GetBundleInput = {
  bundleId: string;
};

type GetBundleChildrenInput = {
  baseBundleId: string;
};

type GetBundleChildCountsInput = {
  bundleIds: string[];
};

type GetBundleDownloadUrlInput = {
  bundleId: string;
};

type UpdateBundleInput = {
  bundleId: string;
  bundle: Partial<Bundle>;
};

type PromoteBundleInput = {
  action: "copy" | "move";
  bundleId: string;
  nextBundleId?: string;
  targetChannel: string;
};

type DeleteBundleInput = {
  bundleId: string;
};

const assertRemoteDownloadUrl = (fileUrl: string) => {
  try {
    const protocol = new URL(fileUrl).protocol.replace(":", "");
    if (protocol === "http" || protocol === "https") {
      return fileUrl;
    }
  } catch {
    // Fall through to the browser-facing error below.
  }

  throw new Error(
    "Storage plugin returned a local file path; browser downloads require an HTTP(S) download URL.",
  );
};

// GET /api/config
export const getConfig = createServerFn().handler(async () => {
  try {
    const { prepareConfig } = await import("./server/config.server");
    const { config } = await prepareConfig();
    return { console: config.console };
  } catch (error) {
    console.error("Error during config retrieval:", error);
    throw error;
  }
});

// GET /api/channels
export const getChannels = createServerFn().handler(async () => {
  try {
    const { prepareConfig } = await import("./server/config.server");
    const { databasePlugin } = await prepareConfig();
    const channels = await databasePlugin.getChannels();
    return channels ?? [];
  } catch (error) {
    console.error("Error during channel retrieval:", error);
    throw error;
  }
});

// GET /api/config-loaded
export const getConfigLoaded = createServerFn().handler(async () => {
  try {
    const { isConfigLoaded } = await import("./server/config.server");
    const configLoaded = isConfigLoaded();
    return { configLoaded };
  } catch (error) {
    console.error("Error during config loaded retrieval:", error);
    throw error;
  }
});

// GET /api/bundles
export const getBundles = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundlesInput | undefined) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const query = {
        channel: data?.channel ?? undefined,
        platform: data?.platform ?? undefined,
        page:
          typeof data?.page === "number" &&
          Number.isInteger(data.page) &&
          data.page > 1
            ? data.page
            : undefined,
        limit: data?.limit ? Number(data.limit) : DEFAULT_PAGE_LIMIT,
        after: data?.after ?? undefined,
        before: data?.before ?? undefined,
      };

      const { databasePlugin } = await prepareConfig();
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
      const bundles = await databasePlugin.getBundles(bundleQueryOptions);

      return (
        bundles ?? {
          data: [],
          pagination: {
            total: 0,
            hasNextPage: false,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 0,
          },
        }
      );
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      throw error;
    }
  });

// GET /api/bundles/:bundleId
export const getBundle = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleInput) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { databasePlugin } = await prepareConfig();
      const bundle = await databasePlugin.getBundleById(data.bundleId);
      return bundle ?? null;
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      throw error;
    }
  });

export const getBundleChildren = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleChildrenInput) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { getBundleChildren: getBundleChildrenWithConfig } =
        await import("./server/getBundleChildren");
      const { databasePlugin } = await prepareConfig();

      return await getBundleChildrenWithConfig(data, {
        databasePlugin,
      });
    } catch (error) {
      console.error("Error during bundle children retrieval:", error);
      throw error;
    }
  });

export const getBundleChildCounts = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleChildCountsInput) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { getBundleChildCounts: getBundleChildCountsWithConfig } =
        await import("./server/getBundleChildren");
      const { databasePlugin } = await prepareConfig();

      return await getBundleChildCountsWithConfig(data.bundleIds, {
        databasePlugin,
      });
    } catch (error) {
      console.error("Error during bundle child count retrieval:", error);
      throw error;
    }
  });

export const getBundleDownloadUrl = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleDownloadUrlInput) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { databasePlugin, storagePlugin } = await prepareConfig();
      const bundle = await databasePlugin.getBundleById(data.bundleId);

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

      if (!storagePlugin) {
        throw new Error("Storage plugin is not configured");
      }

      if (storagePlugin.supportedProtocol !== protocol) {
        throw new Error(`No storage plugin for protocol: ${protocol}`);
      }

      if (!isRuntimeStoragePlugin(storagePlugin)) {
        throw new Error(
          `${storagePlugin.name} does not support runtime download URL resolution.`,
        );
      }

      const downloadTarget =
        await storagePlugin.profiles.runtime.getDownloadUrl(storageUri);
      const { fileUrl } = downloadTarget;

      if (!fileUrl) {
        throw new Error("Storage plugin returned empty fileUrl");
      }

      return { fileUrl: assertRemoteDownloadUrl(fileUrl) };
    } catch (error) {
      console.error("Error during bundle download URL retrieval:", error);
      throw error;
    }
  });

// PATCH /api/bundles/:bundleId
export const updateBundle = createServerFn({ method: "POST" })
  .inputValidator((input: UpdateBundleInput) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { databasePlugin } = await prepareConfig();
      await databasePlugin.updateBundle(data.bundleId, data.bundle);
      await databasePlugin.commitBundle();
      const updatedBundle = await databasePlugin.getBundleById(data.bundleId);

      if (!updatedBundle) {
        throw new Error("Updated bundle not found");
      }

      return { success: true, bundle: updatedBundle };
    } catch (error) {
      console.error("Error during bundle update:", error);
      throw error;
    }
  });

export const promoteBundle = createServerFn({ method: "POST" })
  .inputValidator((input: PromoteBundleInput) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { promoteBundle: promoteBundleWithConfig } =
        await import("@hot-updater/cli-tools");
      const { config, databasePlugin, storagePlugin } = await prepareConfig();
      const bundle = await promoteBundleWithConfig(data, {
        config,
        databasePlugin,
        storagePlugin,
      });

      return { success: true, bundle };
    } catch (error) {
      console.error("Error during bundle promotion:", error);
      throw error;
    }
  });

// POST /api/bundles
export const createBundle = createServerFn({ method: "POST" })
  .inputValidator((input: Bundle) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { databasePlugin } = await prepareConfig();
      await databasePlugin.appendBundle(data);
      await databasePlugin.commitBundle();
      return { success: true, bundleId: data.id };
    } catch (error) {
      console.error("Error during bundle creation:", error);
      throw error;
    }
  });

// DELETE /api/bundles/:bundleId
export const deleteBundle = createServerFn({ method: "POST" })
  .inputValidator((input: DeleteBundleInput) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { deleteBundle: deleteBundleWithStorage } =
        await import("./server/deleteBundle");
      const { databasePlugin, storagePlugin } = await prepareConfig();

      await deleteBundleWithStorage(data, {
        databasePlugin,
        storagePlugin,
        waitForStorageCleanup: false,
      });

      return { success: true };
    } catch (error) {
      console.error("Error during bundle deletion:", error);
      throw error;
    }
  });
