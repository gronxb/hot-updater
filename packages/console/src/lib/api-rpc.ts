import {
  type ChannelDeleteResult,
  type ChannelRow,
  type ReleaseFilter,
  type ReleasePolicyPatch,
  rowToBundle,
} from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/react-start";

import { DEFAULT_PAGE_LIMIT } from "./constants";
import { withPublicBundleMutationErrors } from "./public-bundle-error";
import { listReleases, readReleaseFilter } from "./server/listReleases";
import { addReleaseReachability } from "./server/releaseReachability";

type GetBundlesInput = {
  platform?: "ios" | "android";
  limit?: number;
  /** Bundles older than this id: the next page. */
  after?: string;
  /** Bundles newer than this id: the previous page. */
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
  /** One of the filter sets the release indexes serve. */
  filter?: ReleaseFilter;
  /** Releases older than this id: the next page. */
  beforeReleaseId?: string;
  /** Releases newer than this id: the previous page. */
  afterReleaseId?: string;
  limit?: number;
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

const MAX_PAGE_LIMIT = 100;

const pageLimit = (limit: number | undefined) => {
  const value = limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  return value;
};

const prepare = async () => {
  const { prepareConfig } = await import("./server/config.server");
  return prepareConfig();
};

export const getReleases = createServerFn({ method: "GET" })
  .inputValidator((input: GetReleasesInput | undefined) => ({
    filter: readReleaseFilter(input?.filter),
    ...(input?.afterReleaseId === undefined
      ? {}
      : { afterReleaseId: input.afterReleaseId }),
    ...(input?.beforeReleaseId === undefined
      ? {}
      : { beforeReleaseId: input.beforeReleaseId }),
    limit: pageLimit(input?.limit),
  }))
  .handler(async ({ data }) => {
    const { core } = await prepare();
    const result = await listReleases(core, data);
    return {
      ...result,
      data: await addReleaseReachability(core, result.data),
    };
  });

export const getRelease = createServerFn({ method: "GET" })
  .inputValidator((input: { releaseId: string }) => input)
  .handler(async ({ data }) =>
    (await prepare()).core.getRelease(data.releaseId),
  );

export const updateRelease = createServerFn({ method: "POST" })
  .inputValidator((input: ReleaseMutationInput) => input)
  .handler(async ({ data }) => {
    const { core } = await prepare();
    return withPublicBundleMutationErrors(() => core.updateReleasePolicy(data));
  });

export const preflightRelease = createServerFn({ method: "POST" })
  .inputValidator((input: ReleaseMutationInput) => input)
  .handler(async ({ data }) => {
    const { core } = await prepare();
    return withPublicBundleMutationErrors(() =>
      core.preflightReleasePolicy(data),
    );
  });

export const deleteRelease = createServerFn({ method: "POST" })
  .inputValidator((input: DeleteReleaseInput) => input)
  .handler(async ({ data }) => {
    const { core } = await prepare();
    return withPublicBundleMutationErrors(() => core.deleteRelease(data));
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
    const { core } = await prepare();
    return withPublicBundleMutationErrors(() => core.promoteRelease(data));
  });

export const getReleaseCatalogDiagnostics = createServerFn({ method: "GET" })
  .inputValidator((input: { scopeKey: string }) => input)
  .handler(async ({ data }) =>
    (await prepare()).core.getReleaseCatalogRow(data.scopeKey),
  );

// GET /api/config
export const getConfig = createServerFn().handler(async () => {
  try {
    const { config } = await prepare();
    return { console: config.console };
  } catch (error) {
    console.error("Error during config retrieval:", error);
    throw error;
  }
});

// GET /api/channels
export const getChannels = createServerFn().handler(
  async (): Promise<ChannelRow[]> => {
    try {
      return await (await prepare()).core.listChannels();
    } catch (error) {
      console.error("Error during channel retrieval:", error);
      throw error;
    }
  },
);

// POST /api/channels
export const createChannel = createServerFn({ method: "POST" })
  .inputValidator((input: { name: string }) => {
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (name.length === 0) throw new Error("Channel name is required.");
    return { name };
  })
  .handler(async ({ data }) => {
    try {
      const { core } = await prepare();
      const existing = await core.findChannelByName(data.name);
      if (existing !== null) {
        return { data: { row: existing, inserted: false } };
      }
      return {
        data: { row: await core.ensureChannel(data.name), inserted: true },
      };
    } catch (error) {
      console.error("Error during channel creation:", error);
      throw error;
    }
  });

// DELETE /api/channels/:id
export const deleteChannel = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<{ data: ChannelDeleteResult }> => {
    try {
      return { data: await (await prepare()).core.deleteChannel(data.id) };
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

// GET /api/bundles: newest first, one page by key; the total is one counter row.
export const getBundles = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundlesInput | undefined) => {
    if (input?.after !== undefined && input.before !== undefined) {
      throw new Error("Page by after or before, not both.");
    }
    return {
      ...(input?.platform === undefined ? {} : { platform: input.platform }),
      ...(input?.after === undefined ? {} : { after: input.after }),
      ...(input?.before === undefined ? {} : { before: input.before }),
      limit: pageLimit(input?.limit),
    };
  })
  .handler(async ({ data }) => {
    try {
      const { core } = await prepare();
      const platform =
        data.platform === undefined ? {} : { platform: data.platform };
      const [page, total] = await Promise.all([
        data.before === undefined
          ? core.listBundles({
              ...platform,
              order: "desc",
              limit: data.limit,
              ...(data.after === undefined ? {} : { after: data.after }),
            })
          : core
              .listBundles({
                ...platform,
                order: "asc",
                limit: data.limit,
                after: data.before,
              })
              .then((rows) => rows.reverse()),
        core.countBundles(data.platform),
      ]);
      const full = page.length === data.limit;
      const first = page[0]?.bundle.id;
      const last = page.at(-1)?.bundle.id;
      return {
        data: page.map(({ bundle, patches }) => rowToBundle(bundle, patches)),
        total,
        // A full page may have more past it; a short one ended the range.
        ...(last !== undefined && (data.before !== undefined || full)
          ? { next: last }
          : {}),
        ...(first !== undefined &&
        (data.after !== undefined || (data.before !== undefined && full))
          ? { previous: first }
          : {}),
      };
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
      const detail = await (await prepare()).core.getBundle(data.bundleId);
      return detail === null
        ? null
        : rowToBundle(detail.bundle, detail.patches);
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      throw error;
    }
  });

export const getBundleChildren = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleChildrenInput) => input)
  .handler(async ({ data }) => {
    try {
      const [{ core }, { getBundleChildren: readBundleChildren }] =
        await Promise.all([prepare(), import("./server/getBundleChildren")]);
      return await readBundleChildren(core, data.baseBundleId);
    } catch (error) {
      console.error("Error during bundle children retrieval:", error);
      throw error;
    }
  });

export const getBundleChildCounts = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleChildCountsInput) => {
    if (!Array.isArray(input?.bundleIds) || input.bundleIds.length > 100) {
      throw new Error("Choose up to 100 bundles.");
    }
    return input;
  })
  .handler(async ({ data }) => {
    try {
      const [{ core }, { getBundleChildCounts: readBundleChildCounts }] =
        await Promise.all([prepare(), import("./server/getBundleChildren")]);
      return await readBundleChildCounts(core, data.bundleIds);
    } catch (error) {
      console.error("Error during bundle child count retrieval:", error);
      throw error;
    }
  });

// DELETE /api/bundles/:bundleId
export const deleteBundle = createServerFn({ method: "POST" })
  .inputValidator((input: DeleteBundleInput) => input)
  .handler(async ({ data }) => {
    try {
      const { deleteBundle: deleteBundleWithStorage } =
        await import("./server/deleteBundle");
      const { core, storagePlugin } = await prepare();

      await deleteBundleWithStorage(data, {
        core,
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
      const { deleteBundles: deleteBundlesWithStorage } =
        await import("./server/deleteBundle");
      const { core, storagePlugin } = await prepare();

      const result = await deleteBundlesWithStorage(data, {
        core,
        storagePlugin,
        waitForStorageCleanup: false,
      });

      return { success: true, ...result };
    } catch (error) {
      console.error("Error during bundle deletion:", error);
      throw error;
    }
  });
