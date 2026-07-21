import type { Bundle } from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/react-start";

import { parseActiveInstallationInput } from "./analytics-input";
import {
  type AnalyticsOverview,
  createAnalyticsOverviewFromCounts,
} from "./analytics-overview";

const DEFAULT_ANALYTICS_PAGE_SIZE = 100;
const MAX_ANALYTICS_BUNDLE_PAGES = 100;
const MAX_ANALYTICS_BUNDLES = 10_000;

export type AnalyticsCapabilities = {
  readonly capabilities:
    | { readonly analytics: false }
    | {
        readonly analytics: true;
        readonly mode: "bounded";
        readonly maxMatchingRows: number;
      }
    | { readonly analytics: true; readonly mode: "dedicated" };
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
    super("Analytics are not supported by the configured database plugin.");
    this.name = "AnalyticsNotSupportedError";
  }
}

const internalAnalyticsCapabilityProbe = Symbol.for(
  "@hot-updater/internal/analytics-capability-probe",
);

const isProbedCapabilities = (
  value: unknown,
): value is AnalyticsCapabilities["capabilities"] => {
  if (typeof value !== "object" || value === null) return false;
  const analytics = Reflect.get(value, "analytics");
  if (analytics === false) return true;
  const mode = Reflect.get(value, "mode");
  if (analytics !== true) return false;
  if (mode === "dedicated") return true;
  const maxMatchingRows = Reflect.get(value, "maxMatchingRows");
  return (
    mode === "bounded" &&
    typeof maxMatchingRows === "number" &&
    Number.isFinite(maxMatchingRows) &&
    maxMatchingRows > 0
  );
};

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
  if (!supportsAnalytics(runtime)) {
    return { capabilities: { analytics: false } };
  }
  const probe = Reflect.get(runtime, internalAnalyticsCapabilityProbe);
  if (typeof probe === "function") {
    const capabilities: unknown = await Reflect.apply(probe, runtime, []);
    return {
      capabilities: isProbedCapabilities(capabilities)
        ? capabilities
        : { analytics: false },
    };
  }
  const metadata = Reflect.get(
    runtime,
    Symbol.for("@hot-updater/server/analytics-capability"),
  );
  if (typeof metadata === "object" && metadata !== null) {
    const mode = Reflect.get(metadata, "mode");
    const maxMatchingRows = Reflect.get(metadata, "maxMatchingRows");
    if (
      mode === "bounded" &&
      typeof maxMatchingRows === "number" &&
      Number.isFinite(maxMatchingRows) &&
      maxMatchingRows > 0
    ) {
      return {
        capabilities: { analytics: true, mode, maxMatchingRows },
      };
    }
  }
  return { capabilities: { analytics: true, mode: "dedicated" } };
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
  const { capabilities } = await getAnalyticsCapabilities(runtime);
  if (!capabilities.analytics) {
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
