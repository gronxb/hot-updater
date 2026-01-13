import { createServerFn } from "@tanstack/react-start";
import type { Bundle } from "@hot-updater/plugin-core";
import { prepareConfig, isConfigLoaded } from "./config.server";
import { DEFAULT_PAGE_LIMIT, DEFAULT_PAGE_OFFSET } from "../constants";

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
export const getBundles = createServerFn({ method: "GET" }).handler(
  async ({
    data,
  }: {
    data?: {
      channel?: string;
      platform?: "ios" | "android";
      limit?: string;
      offset?: string;
    };
  }) => {
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
  },
);

// GET /api/bundles/:bundleId
export const getBundle = createServerFn({ method: "GET" }).handler(
  async ({ data }: { data?: { bundleId: string } }) => {
    try {
      const { databasePlugin } = await prepareConfig();
      const bundle = await databasePlugin.getBundleById(data?.bundleId ?? "");
      return bundle ?? null;
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      throw error;
    }
  },
);

// GET /api/bundles/:bundleId/rollout-stats
export const getRolloutStats = createServerFn({ method: "GET" }).handler(
  async ({ data }: { data?: { bundleId: string } }) => {
    try {
      const { databasePlugin } = await prepareConfig();

      if (!databasePlugin.getRolloutStats) {
        return {
          totalDevices: 0,
          promotedCount: 0,
          recoveredCount: 0,
          successRate: 0,
        };
      }

      const stats = await databasePlugin.getRolloutStats(data?.bundleId ?? "");
      return stats;
    } catch (error) {
      console.error("Error during rollout stats retrieval:", error);
      throw error;
    }
  },
);

// PATCH /api/bundles/:bundleId
export const updateBundle = createServerFn({ method: "POST" }).handler(
  async ({
    data,
  }: {
    data?: { bundleId: string; bundle: Partial<Bundle> };
  }) => {
    try {
      const { databasePlugin } = await prepareConfig();
      await databasePlugin.updateBundle(
        data?.bundleId ?? "",
        data?.bundle ?? {},
      );
      await databasePlugin.commitBundle();
      return { success: true };
    } catch (error) {
      console.error("Error during bundle update:", error);
      throw error;
    }
  },
);

// POST /api/bundles
export const createBundle = createServerFn({ method: "POST" }).handler(
  async ({ data }: { data?: Bundle }) => {
    try {
      const { databasePlugin } = await prepareConfig();
      if (!data) {
        throw new Error("Bundle data is required");
      }
      await databasePlugin.appendBundle(data);
      await databasePlugin.commitBundle();
      return { success: true, bundleId: data.id };
    } catch (error) {
      console.error("Error during bundle creation:", error);
      throw error;
    }
  },
);

// DELETE /api/bundles/:bundleId
export const deleteBundle = createServerFn({ method: "POST" }).handler(
  async ({ data }: { data?: { bundleId: string } }) => {
    try {
      const { databasePlugin } = await prepareConfig();
      const bundle = await databasePlugin.getBundleById(data?.bundleId ?? "");
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
  },
);

export const getDeviceEvents = createServerFn({ method: "GET" }).handler(
  async ({
    data,
  }: {
    data?: {
      bundleId?: string;
      platform?: "ios" | "android";
      channel?: string;
      eventType?: "PROMOTED" | "RECOVERED";
      limit?: number;
      offset?: number;
    };
  }) => {
    try {
      const { databasePlugin } = await prepareConfig();

      const emptyResult = {
        data: [] as Array<{
          id?: string;
          deviceId: string;
          bundleId: string;
          eventType: "PROMOTED" | "RECOVERED";
          platform: "ios" | "android";
          appVersion?: string;
          channel: string;
          metadata?: Record<string, object>;
          createdAt?: string;
        }>,
        pagination: {
          total: 0,
          hasNextPage: false,
          hasPreviousPage: false,
          currentPage: 1,
          totalPages: 0,
        },
      };

      if (!databasePlugin.getDeviceEvents) {
        return emptyResult;
      }

      const result = await databasePlugin.getDeviceEvents(data);

      return {
        data: result.data.map((event) => ({
          id: event.id,
          deviceId: event.deviceId,
          bundleId: event.bundleId,
          eventType: event.eventType,
          platform: event.platform,
          appVersion: event.appVersion,
          channel: event.channel,
          metadata: event.metadata as Record<string, object> | undefined,
          createdAt: event.createdAt,
        })),
        pagination: result.pagination,
      };
    } catch (error) {
      console.error("Error during device events retrieval:", error);
      throw error;
    }
  },
);
