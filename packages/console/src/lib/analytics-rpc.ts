import type { Bundle } from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/react-start";

import {
  type AnalyticsOverview,
  createAnalyticsOverviewFromCounts,
} from "./analytics-overview";

const DEFAULT_ANALYTICS_PAGE_SIZE = 100;
const MAX_ANALYTICS_BUNDLE_PAGES = 100;
const MAX_ANALYTICS_BUNDLES = 10_000;

export type AnalyticsCapabilities = {
  readonly capabilities: {
    readonly analytics: boolean;
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
  readonly pageSize?: number;
};

export class AnalyticsNotSupportedError extends Error {
  constructor() {
    super("Analytics are not supported by the configured database adapter.");
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
  if (typeof runtime !== "object" || runtime === null) {
    return { capabilities: { analytics: false } };
  }
  const { supportsAnalytics } = await import("@hot-updater/server/db");
  return { capabilities: { analytics: supportsAnalytics(runtime) } };
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
    if (totalPages > MAX_ANALYTICS_BUNDLE_PAGES) {
      throw new AnalyticsBundlePaginationError(
        page,
        `totalPages exceeds the ${MAX_ANALYTICS_BUNDLE_PAGES}-page limit`,
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
    if (bundles.length + result.data.length > MAX_ANALYTICS_BUNDLES) {
      throw new AnalyticsBundlePaginationError(
        page,
        `bundle count exceeds the ${MAX_ANALYTICS_BUNDLES}-bundle limit`,
      );
    }

    bundles.push(...result.data);
    if (!hasNextPage) {
      return bundles;
    }
    page += 1;
  }
};

export const collectAnalyticsOverview = async ({
  runtime,
  getBundles,
  pageSize = DEFAULT_ANALYTICS_PAGE_SIZE,
}: AnalyticsOverviewDependencies): Promise<AnalyticsOverview> => {
  const { supportsAnalytics } = await import("@hot-updater/server/db");
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    !supportsAnalytics(runtime)
  ) {
    throw new AnalyticsNotSupportedError();
  }

  const bundles = await collectBundles(getBundles, pageSize);
  const overview = await runtime.getBundleEventOverview();
  return createAnalyticsOverviewFromCounts(
    bundles,
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
  const { databaseClient, hotUpdater } = await prepareConfig();
  return collectAnalyticsOverview({
    runtime: hotUpdater,
    getBundles: (options) => databaseClient.getBundles(options),
  });
});
