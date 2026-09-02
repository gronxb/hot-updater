import {
  DatabasePluginInputError,
  type Bundle,
  type ChannelDeleteInput,
  type ChannelInsertInput,
  type DatabaseBundleQueryOptions,
  deleteRelease as deleteReleaseMutation,
  preflightReleasePolicy,
  promoteRelease as promoteReleaseMutation,
  type ReleasePolicyPatch,
  updateReleasePolicy,
} from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/react-start";

import { DEFAULT_PAGE_LIMIT } from "./constants";
import {
  parseBundleEventInsightsInput,
  parseBundleEventSummaryInput,
  parseEventHistoryInput,
  parseInstallationHistoryInput,
  parseSearchInstallationsInput,
} from "./insights-input";
import { withPublicBundleMutationErrors } from "./public-bundle-error";
import { listReleases } from "./server/listReleases";
import { getReleaseActivity30d } from "./server/releaseActivity";
import { addReleaseReachability } from "./server/releaseReachability";

type GetBundlesInput = {
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

type DeleteBundleInput = {
  bundleId: string;
};

type DeleteBundlesInput = {
  bundleIds: string[];
};

type GetReleasesInput = {
  afterReleaseId?: string;
  beforeReleaseId?: string;
  bundleId?: string;
  channelId?: string;
  enabled?: boolean;
  platform?: "ios" | "android";
  limit?: number;
  page?: number;
  targetAppVersion?: string;
};

type ReleaseMutationInput = {
  expectedRevision?: number;
  patch: ReleasePolicyPatch;
  releaseId: string;
};

type DeleteReleaseInput = {
  expectedRevision?: number;
  releaseId: string;
};

export const getReleases = createServerFn({ method: "GET" })
  .inputValidator((input: GetReleasesInput | undefined) => input)
  .handler(async ({ data }) => {
    const { prepareConfig } = await import("./server/config.server");
    const { config, hotUpdater } = await prepareConfig();
    const result = await listReleases(config.database.models.releases, {
      ...(data?.afterReleaseId === undefined
        ? {}
        : { afterReleaseId: data.afterReleaseId }),
      ...(data?.beforeReleaseId === undefined
        ? {}
        : { beforeReleaseId: data.beforeReleaseId }),
      ...(data?.bundleId === undefined ? {} : { bundleId: data.bundleId }),
      ...(data?.channelId === undefined ? {} : { channelId: data.channelId }),
      ...(data?.enabled === undefined ? {} : { enabled: data.enabled }),
      ...(data?.page === undefined ? {} : { page: data.page }),
      ...(data?.platform === undefined ? {} : { platform: data.platform }),
      ...(data?.targetAppVersion === undefined
        ? {}
        : { targetAppVersion: data.targetAppVersion }),
      limit: data?.limit ?? DEFAULT_PAGE_LIMIT,
    });
    const [releases, activityByBundleId] = await Promise.all([
      addReleaseReachability(
        config.database.models.releaseCatalogs,
        result.data,
      ),
      getReleaseActivity30d(hotUpdater, result.data),
    ]);
    return {
      ...result,
      data: releases.map((release) => ({
        ...release,
        activity30d:
          release.bundle_id === null
            ? null
            : (activityByBundleId.get(release.bundle_id) ?? null),
      })),
    };
  });

export const getRelease = createServerFn({ method: "GET" })
  .inputValidator((input: { releaseId: string }) => input)
  .handler(async ({ data }) => {
    const { prepareConfig } = await import("./server/config.server");
    const { config } = await prepareConfig();
    return config.database.models.releases.findById(data.releaseId);
  });

export const updateRelease = createServerFn({ method: "POST" })
  .inputValidator((input: ReleaseMutationInput) => input)
  .handler(async ({ data }) => {
    const { prepareConfig } = await import("./server/config.server");
    const { config } = await prepareConfig();
    return withPublicBundleMutationErrors(() =>
      updateReleasePolicy({ database: config.database, ...data }),
    );
  });

export const preflightRelease = createServerFn({ method: "POST" })
  .inputValidator((input: ReleaseMutationInput) => input)
  .handler(async ({ data }) => {
    const { prepareConfig } = await import("./server/config.server");
    const { config } = await prepareConfig();
    return withPublicBundleMutationErrors(() =>
      preflightReleasePolicy({ database: config.database, ...data }),
    );
  });

export const deleteRelease = createServerFn({ method: "POST" })
  .inputValidator((input: DeleteReleaseInput) => input)
  .handler(async ({ data }) => {
    const { prepareConfig } = await import("./server/config.server");
    const { config } = await prepareConfig();
    return withPublicBundleMutationErrors(() =>
      deleteReleaseMutation({ database: config.database, ...data }),
    );
  });

export const promoteRelease = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      action: "copy" | "move";
      expectedRevision?: number;
      releaseId: string;
      targetChannel: string;
    }) => input,
  )
  .handler(async ({ data }) => {
    const { prepareConfig } = await import("./server/config.server");
    const { config } = await prepareConfig();
    return withPublicBundleMutationErrors(() =>
      promoteReleaseMutation({ database: config.database, ...data }),
    );
  });

export const getReleaseCatalogDiagnostics = createServerFn({ method: "GET" })
  .inputValidator((input: { scopeKey: string }) => input)
  .handler(async ({ data }) => {
    const { prepareConfig } = await import("./server/config.server");
    const { config } = await prepareConfig();
    return config.database.models.releaseCatalogs.findByScopeKey(data.scopeKey);
  });

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
    const { databaseClient } = await prepareConfig();
    const channels = await databaseClient.getChannels();
    return channels ?? [];
  } catch (error) {
    console.error("Error during channel retrieval:", error);
    throw error;
  }
});

// POST /api/channels
export const createChannel = createServerFn({ method: "POST" })
  .inputValidator((input: ChannelInsertInput) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { databaseClient } = await prepareConfig();
      return { data: await databaseClient.insertChannel(data) };
    } catch (error) {
      console.error("Error during channel creation:", error);
      throw error;
    }
  });

// DELETE /api/channels/:id
export const deleteChannel = createServerFn({ method: "POST" })
  .inputValidator((input: ChannelDeleteInput) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { databaseClient } = await prepareConfig();
      return { data: await databaseClient.deleteChannel(data) };
    } catch (error) {
      console.error("Error during channel deletion:", error);
      throw error;
    }
  });

// GET /api/config-loaded
export const getConfigLoaded = createServerFn().handler(async () => {
  try {
    const [{ getRequest }, { requireConsoleAccess }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./server/auth.server"),
    ]);
    await requireConsoleAccess(getRequest());
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
      if (
        (query.after !== undefined && query.before !== undefined) ||
        (query.page !== undefined &&
          (query.after !== undefined || query.before !== undefined))
      ) {
        throw new DatabasePluginInputError("invalid-pagination");
      }
      const pagination =
        query.page !== undefined
          ? { page: query.page }
          : query.after !== undefined
            ? { cursor: { after: query.after } }
            : query.before !== undefined
              ? { cursor: { before: query.before } }
              : {};

      const { databaseClient } = await prepareConfig();
      const bundleQueryOptions: DatabaseBundleQueryOptions = {
        where: {
          platform: query.platform,
        },
        limit: query.limit,
        ...pagination,
      };
      const bundles = await databaseClient.getBundles(bundleQueryOptions);

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
      const { databaseClient } = await prepareConfig();
      const bundle = await databaseClient.getBundleById(data.bundleId);
      return bundle ?? null;
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      throw error;
    }
  });

export const getBundleEventSummary = createServerFn({ method: "GET" })
  .inputValidator(parseBundleEventSummaryInput)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { getBundleEventSummary: getBundleEventSummaryWithRuntime } =
        await import("./server/runtime.server");
      const { hotUpdater } = await prepareConfig();

      return await getBundleEventSummaryWithRuntime(hotUpdater, data);
    } catch (error) {
      console.error("Error during bundle event summary retrieval:", error);
      throw error;
    }
  });

export const getBundleEventInsights = createServerFn({ method: "GET" })
  .inputValidator(parseBundleEventInsightsInput)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { getBundleEventInsights: getBundleEventInsightsWithRuntime } =
        await import("./server/runtime.server");
      const { hotUpdater } = await prepareConfig();

      return await getBundleEventInsightsWithRuntime(hotUpdater, data);
    } catch (error) {
      console.error("Error during bundle event insights retrieval:", error);
      throw error;
    }
  });

export const searchInstallations = createServerFn({ method: "GET" })
  .inputValidator(parseSearchInstallationsInput)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { searchInstallations: searchInstallationsWithRuntime } =
        await import("./server/runtime.server");
      const { hotUpdater } = await prepareConfig();

      return await searchInstallationsWithRuntime(hotUpdater, data);
    } catch (error) {
      console.error("Error during installation search:", error);
      throw error;
    }
  });

export const getEventHistory = createServerFn({ method: "GET" })
  .inputValidator(parseEventHistoryInput)
  .handler(async ({ data }) => {
    const { prepareConfig } = await import("./server/config.server");
    const { getEventHistory: getEventHistoryWithRuntime } =
      await import("./server/runtime.server");
    const { hotUpdater } = await prepareConfig();
    return getEventHistoryWithRuntime(hotUpdater, data);
  });

export const getInstallationHistory = createServerFn({ method: "GET" })
  .inputValidator(parseInstallationHistoryInput)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { getInstallationHistory: getInstallationHistoryWithRuntime } =
        await import("./server/runtime.server");
      const { hotUpdater } = await prepareConfig();

      return await getInstallationHistoryWithRuntime(hotUpdater, data);
    } catch (error) {
      console.error("Error during installation history retrieval:", error);
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
      const { databaseClient } = await prepareConfig();

      return await getBundleChildrenWithConfig(data, {
        databaseClient,
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
      const { databaseClient } = await prepareConfig();

      return await getBundleChildCountsWithConfig(data.bundleIds, {
        databaseClient,
      });
    } catch (error) {
      console.error("Error during bundle child count retrieval:", error);
      throw error;
    }
  });

// POST /api/bundles
export const createBundle = createServerFn({ method: "POST" })
  .inputValidator((input: Bundle) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { databaseClient } = await prepareConfig();
      await databaseClient.insertBundle(data);
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
      const { databaseClient, storagePlugin } = await prepareConfig();

      await deleteBundleWithStorage(data, {
        databaseClient,
        storagePlugin,
        waitForStorageCleanup: false,
      });

      return { success: true };
    } catch (error) {
      console.error("Error during bundle deletion:", error);
      throw error;
    }
  });

export const deleteBundles = createServerFn({ method: "POST" })
  .inputValidator((input: DeleteBundlesInput) => input)
  .handler(async ({ data }) => {
    try {
      const { prepareConfig } = await import("./server/config.server");
      const { deleteBundles: deleteBundlesWithStorage } =
        await import("./server/deleteBundle");
      const { databaseClient, storagePlugin } = await prepareConfig();

      const result = await deleteBundlesWithStorage(data, {
        databaseClient,
        storagePlugin,
        waitForStorageCleanup: false,
      });

      return { success: true, ...result };
    } catch (error) {
      console.error("Error during bundle deletion:", error);
      throw error;
    }
  });
