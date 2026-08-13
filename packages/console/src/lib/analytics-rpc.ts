import type { Bundle, ChannelRow, ReleaseRow } from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/react-start";

import { parseActiveInstallationInput } from "./analytics-input";
import {
  type AnalyticsOverview,
  createAnalyticsOverviewFromCounts,
} from "./analytics-overview";

const DEFAULT_ANALYTICS_PAGE_SIZE = 100;

export type AnalyticsCapabilities = {
  readonly capabilities:
    | { readonly analytics: false }
    | {
        readonly analytics: true;
        readonly mode: "bounded";
        readonly maxMatchingRows: number;
      };
};

type BundlePage = {
  readonly data: readonly Bundle[];
  readonly pagination: {
    readonly hasNextPage: boolean;
    readonly currentPage: number;
    readonly totalPages: number;
  };
};

type AnalyticsOverviewDependencies = {
  readonly runtime: unknown;
  readonly getBundles: (options: {
    readonly limit: number;
    readonly page: number;
  }) => Promise<BundlePage>;
  readonly getReleases: (options: {
    readonly beforeReleaseId?: string;
    readonly limit: number;
  }) => Promise<readonly ReleaseRow[]>;
  readonly getChannels: () => Promise<readonly ChannelRow[]>;
  readonly pageSize?: number;
};

export class AnalyticsNotSupportedError extends Error {
  constructor() {
    super("Analytics are not supported by the configured database plugin.");
    this.name = "AnalyticsNotSupportedError";
  }
}

export class AnalyticsBundlePaginationError extends Error {
  readonly name = "AnalyticsBundlePaginationError";

  constructor(
    readonly requestedPage: number,
    readonly reason: string,
  ) {
    super(`Invalid bundle pagination for page ${requestedPage}: ${reason}`);
  }
}

export const getAnalyticsCapabilities = async (
  runtime: unknown,
): Promise<AnalyticsCapabilities> => {
  const { getAnalyticsCapability } = await import("./server/runtime.server");
  const capability = await getAnalyticsCapability(runtime);
  if (!capability.analytics || !capability.analyticsQueries) {
    return { capabilities: { analytics: false } };
  }
  return {
    capabilities: {
      analytics: true,
      mode: "bounded",
      maxMatchingRows: capability.maxMatchingRows,
    },
  };
};

const collectBundles = async (
  getBundles: AnalyticsOverviewDependencies["getBundles"],
  pageSize: number,
): Promise<readonly Bundle[]> => {
  const bundles: Bundle[] = [];
  let page = 1;
  while (true) {
    const result = await getBundles({ limit: pageSize, page });
    const { currentPage, hasNextPage, totalPages } = result.pagination;
    const isEmptyFirstPage =
      page === 1 &&
      currentPage === 1 &&
      totalPages === 0 &&
      result.data.length === 0 &&
      hasNextPage === false;

    if (currentPage !== page) {
      throw new AnalyticsBundlePaginationError(
        page,
        `currentPage must equal ${page}, received ${currentPage}`,
      );
    }
    if (!Number.isFinite(totalPages) || !Number.isInteger(totalPages)) {
      throw new AnalyticsBundlePaginationError(
        page,
        `totalPages must be a finite integer, received ${totalPages}`,
      );
    }
    if (totalPages < 0) {
      throw new AnalyticsBundlePaginationError(
        page,
        `totalPages must be nonnegative, received ${totalPages}`,
      );
    }
    if (!isEmptyFirstPage && totalPages < currentPage) {
      throw new AnalyticsBundlePaginationError(
        page,
        `totalPages ${totalPages} is lower than currentPage ${currentPage}`,
      );
    }
    if (!isEmptyFirstPage && hasNextPage !== currentPage < totalPages) {
      throw new AnalyticsBundlePaginationError(
        page,
        "hasNextPage contradicts currentPage and totalPages",
      );
    }
    bundles.push(...result.data);
    if (!hasNextPage) {
      return bundles;
    }
    page += 1;
  }
};

const collectReleases = async (
  getReleases: AnalyticsOverviewDependencies["getReleases"],
  pageSize: number,
): Promise<readonly ReleaseRow[]> => {
  const releases: ReleaseRow[] = [];
  const cursors = new Set<string>();
  let beforeReleaseId: string | undefined;
  while (true) {
    const page = await getReleases({ beforeReleaseId, limit: pageSize });
    releases.push(...page);
    if (page.length < pageSize) return releases;
    const nextCursor = page.at(-1)?.id;
    if (!nextCursor || cursors.has(nextCursor)) {
      throw new AnalyticsBundlePaginationError(
        releases.length,
        "release cursor did not advance",
      );
    }
    cursors.add(nextCursor);
    beforeReleaseId = nextCursor;
  }
};

export const collectAnalyticsOverview = async ({
  runtime,
  getBundles,
  getReleases,
  getChannels,
  pageSize = DEFAULT_ANALYTICS_PAGE_SIZE,
}: AnalyticsOverviewDependencies): Promise<AnalyticsOverview> => {
  const { capabilities } = await getAnalyticsCapabilities(runtime);
  if (!capabilities.analytics) {
    throw new AnalyticsNotSupportedError();
  }

  const [bundles, releases, channels] = await Promise.all([
    collectBundles(getBundles, pageSize),
    collectReleases(getReleases, pageSize),
    getChannels(),
  ]);
  const overview = await (
    runtime as import("@hot-updater/server").AnalyticsProvider
  ).getBundleEventOverview();
  return createAnalyticsOverviewFromCounts(
    bundles,
    releases,
    channels,
    overview.trackedInstallations,
    overview.bundles,
  );
};

export const getAnalyticsCapabilitiesRpc = createServerFn({
  method: "GET",
}).handler(async () => {
  const { prepareConfig } = await import("./server/config.server");
  const { hotUpdater } = await prepareConfig();
  return getAnalyticsCapabilities(hotUpdater);
});

export const getAnalyticsOverviewRpc = createServerFn({
  method: "GET",
}).handler(async () => {
  const { prepareConfig } = await import("./server/config.server");
  const { config, databaseClient, hotUpdater } = await prepareConfig();
  return collectAnalyticsOverview({
    runtime: hotUpdater,
    getBundles: (options) => databaseClient.getBundles(options),
    getReleases: (options) => config.database.models.releases.findMany(options),
    getChannels: () =>
      config.database.models.channels.list({}).then(({ channels }) => channels),
  });
});

export const getActiveInstallationOverviewRpc = createServerFn({
  method: "GET",
})
  .validator(parseActiveInstallationInput)
  .handler(async ({ data }) => {
    const { prepareConfig } = await import("./server/config.server");
    const { getActiveInstallationOverview } =
      await import("./server/runtime.server");
    const { hotUpdater } = await prepareConfig();
    return getActiveInstallationOverview(hotUpdater, data);
  });
