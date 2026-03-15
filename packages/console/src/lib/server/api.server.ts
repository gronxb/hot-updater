import type { Bundle } from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/react-start";
import { DEFAULT_PAGE_LIMIT, DEFAULT_PAGE_OFFSET } from "../constants";
import { isConfigLoaded, prepareConfig } from "./config.server";

type GetBundlesInput = {
  channel?: string;
  platform?: "ios" | "android";
  limit?: string;
  offset?: string;
};

type GetBundleInput = {
  bundleId: string;
};

type UpdateBundleInput = {
  bundleId: string;
  bundle: Partial<Bundle>;
};

type DeleteBundleInput = {
  bundleId: string;
};

// GET /api/config
export const getConfig = createServerFn().handler(async () => {
  try {
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
      const query = {
        channel: data?.channel ?? undefined,
        platform: data?.platform ?? undefined,
        limit: data?.limit ? Number(data.limit) : DEFAULT_PAGE_LIMIT,
        offset: data?.offset ? Number(data.offset) : DEFAULT_PAGE_OFFSET,
      };

      const { databasePlugin } = await prepareConfig();
      const bundles = await databasePlugin.getBundles({
        where: {
          channel: query.channel,
          platform: query.platform,
        },
        limit: query.limit,
        offset: query.offset,
      });

      return (
        bundles ?? {
          data: [],
          pagination: { total: 0, limit: query.limit, offset: query.offset },
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
      const { databasePlugin } = await prepareConfig();
      const bundle = await databasePlugin.getBundleById(data.bundleId);
      return bundle ?? null;
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      throw error;
    }
  });

// PATCH /api/bundles/:bundleId
export const updateBundle = createServerFn({ method: "POST" })
  .inputValidator((input: UpdateBundleInput) => input)
  .handler(async ({ data }) => {
    try {
      const { databasePlugin } = await prepareConfig();
      await databasePlugin.updateBundle(data.bundleId, data.bundle);
      await databasePlugin.commitBundle();
      return { success: true };
    } catch (error) {
      console.error("Error during bundle update:", error);
      throw error;
    }
  });

// POST /api/bundles
export const createBundle = createServerFn({ method: "POST" })
  .inputValidator((input: Bundle) => input)
  .handler(async ({ data }) => {
    try {
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
      const { databasePlugin } = await prepareConfig();
      const bundle = await databasePlugin.getBundleById(data.bundleId);
      if (!bundle) {
        throw new Error("Bundle not found");
      }
      await databasePlugin.deleteBundle(bundle);
      await databasePlugin.commitBundle();
      return { success: true };
    } catch (error) {
      console.error("Error during bundle deletion:", error);
      throw error;
    }
  });
