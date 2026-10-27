import {
  type ChannelDeleteResult,
  type ChannelRow,
  type ReleaseFilter,
  type ReleasePolicyPatch,
  rowToBundle,
} from "@hot-updater/plugin-core";
import { assertCanonicalChannelName } from "@hot-updater/protocol";
import type { NativeArtifactInfo } from "@hot-updater/protocol/native-artifact";
import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";
import { DEFAULT_PAGE_LIMIT } from "./constants";
import { channelIdOf, releaseNativeBuildScope } from "./native-builds";
import { withPublicBundleMutationErrors } from "./public-bundle-error";
import { listReleases, readReleaseFilter } from "./server/listReleases";
import { addReleaseReachability } from "./server/releaseReachability";

type GetBundleInput = {
  bundleId: string;
};

type GetBundleChildrenInput = {
  baseBundleId: string;
};

type GetBundleChildCountsInput = {
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
  .middleware([consoleAccess])
  .validator((input: GetReleasesInput | undefined) => ({
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
  .middleware([consoleAccess])
  .validator((input: { releaseId: string }) => input)
  .handler(async ({ data }) =>
    (await prepare()).core.getRelease(data.releaseId),
  );

export const updateRelease = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: ReleaseMutationInput) => input)
  .handler(async ({ data }) => {
    const { core } = await prepare();
    return withPublicBundleMutationErrors(() => core.updateReleasePolicy(data));
  });

export const preflightRelease = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: ReleaseMutationInput) => input)
  .handler(async ({ data }) => {
    const { core } = await prepare();
    return withPublicBundleMutationErrors(() =>
      core.preflightReleasePolicy(data),
    );
  });

export const deleteRelease = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: DeleteReleaseInput) => input)
  .handler(async ({ data }) => {
    const { core } = await prepare();
    return withPublicBundleMutationErrors(() => core.deleteRelease(data));
  });

export const promoteRelease = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(
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
  .middleware([consoleAccess])
  .validator((input: { scopeKey: string }) => input)
  .handler(async ({ data }) =>
    (await prepare()).core.getReleaseCatalogRow(data.scopeKey),
  );

export const getConfig = createServerFn()
  .middleware([consoleAccess])
  .handler(async () => {
    try {
      const { config } = await prepare();
      return {
        console: {
          gitUrl: config.gitUrl,
          channelLinkPrefix: config.channelLinkPrefix,
        },
      };
    } catch (error) {
      console.error("Error during config retrieval:", error);
      throw error;
    }
  });

export const getChannels = createServerFn()
  .middleware([consoleAccess])
  .handler(async (): Promise<ChannelRow[]> => {
    try {
      return await (await prepare()).core.listChannels();
    } catch (error) {
      console.error("Error during channel retrieval:", error);
      throw error;
    }
  });

export const createChannel = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: { name: string }) => {
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

export const deleteChannel = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<{ data: ChannelDeleteResult }> => {
    try {
      return { data: await (await prepare()).core.deleteChannel(data.id) };
    } catch (error) {
      console.error("Error during channel deletion:", error);
      throw error;
    }
  });

export const getBundle = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator((input: GetBundleInput) => input)
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
  .middleware([consoleAccess])
  .validator((input: GetBundleChildrenInput) => input)
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
  .middleware([consoleAccess])
  .validator((input: GetBundleChildCountsInput) => {
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

/** A channel name the list filters by, as its channel ID. */
const channelIdFilter = (channel: unknown) => {
  if (channel === undefined) return {};
  if (typeof channel !== "string") throw new Error("channel must be a name.");
  assertCanonicalChannelName(channel);
  return { channelId: channelIdOf(channel) };
};

export const getNativeBuilds = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(
    (
      input:
        | { before?: string; after?: string; channel?: string; limit?: number }
        | undefined,
    ) => ({
      ...(input?.before === undefined ? {} : { before: input.before }),
      ...(input?.after === undefined ? {} : { after: input.after }),
      ...channelIdFilter(input?.channel),
      limit: pageLimit(input?.limit),
    }),
  )
  .handler(async ({ data }) => {
    const [{ core }, { listNativeBuilds }] = await Promise.all([
      prepare(),
      import("./server/nativeBuilds"),
    ]);
    return listNativeBuilds(core, data);
  });

/** A native build's page: the build, its built-in bundle, what it is served, and its patches. */
export const getNativeBuildDetail = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const [{ core }, { getNativeBuildDetail: readNativeBuildDetail }] =
      await Promise.all([prepare(), import("./server/nativeBuilds")]);
    return readNativeBuildDetail(core, data.id);
  });

/** One page of the patches from a native build's built-in bundle. */
export const getNativeBuildPatches = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(
    (input: { minBundleId: string; before?: string; after?: string }) => ({
      minBundleId: input.minBundleId,
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.after === undefined ? {} : { after: input.after }),
    }),
  )
  .handler(async ({ data: { minBundleId, ...page } }) => {
    const [{ core }, { listNativeBuildPatches, NATIVE_BUILD_PATCH_PAGE_SIZE }] =
      await Promise.all([prepare(), import("./server/nativeBuilds")]);
    return listNativeBuildPatches(core, minBundleId, {
      ...page,
      limit: NATIVE_BUILD_PATCH_PAGE_SIZE,
    });
  });

/**
 * The newest native build of a release's scope, which its patches start
 * from: one read. A release of an app version range has no one build, and
 * reads nothing.
 */
export const getReleaseNativeBuild = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(
    (input: {
      platform: "ios" | "android";
      channel: string;
      fingerprintHash: string | null;
      targetAppVersion: string | null;
    }) => input,
  )
  .handler(async ({ data }) => {
    const scope = releaseNativeBuildScope(data);
    if (scope === null) return null;
    return (await prepare()).core.findNativeBuild(scope);
  });

/**
 * The URL a phone downloads a build from without the console's sign-in, or
 * null when the storage gives none: the storage's download URL, resolved
 * again each time it is read, since it may expire.
 */
export const getNativeBuildDownloadUrl = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const [deps, { resolveNativeBuildDownloadUrl }] = await Promise.all([
      prepare(),
      import("./server/nativeBuilds"),
    ]);
    return { url: await resolveNativeBuildDownloadUrl(data.id, deps) };
  });

/**
 * Whether an artifact the browser read can be imported, before its upload:
 * the strategy it registers by, the shared check, and whether its build is
 * already registered. The upload checks the artifact itself again.
 */
export const checkNativeBuildImport = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: NativeArtifactInfo) => {
    if (typeof input !== "object" || input === null) {
      throw new Error("The artifact's values are required.");
    }
    return input;
  })
  .handler(async ({ data }) => {
    const [{ core, config }, { checkNativeBuildImport: check }] =
      await Promise.all([prepare(), import("./server/nativeBuildImport")]);
    return check(core, config.updateStrategy, data);
  });
