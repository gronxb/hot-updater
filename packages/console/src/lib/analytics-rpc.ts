import type { Bundle } from "@hot-updater/plugin-core";
import type { InstallationSearchRow } from "@hot-updater/server/db";
import { createServerFn } from "@tanstack/react-start";

import {
  type AnalyticsOverview,
  createAnalyticsOverviewAccumulator,
} from "./analytics-overview";

const DEFAULT_ANALYTICS_PAGE_SIZE = 100;

export type AnalyticsCapabilities = {
  readonly supportsBundleEvents: boolean;
};

type BundlePage = {
  readonly data: readonly Bundle[];
  readonly pagination: {
    readonly hasNextPage: boolean;
    readonly currentPage: number;
    readonly totalPages: number;
  };
};

type InstallationPage = {
  readonly data: readonly InstallationSearchRow[];
  readonly pagination: {
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
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

export const getAnalyticsCapabilities = async (
  runtime: unknown,
): Promise<AnalyticsCapabilities> => {
  if (typeof runtime !== "object" || runtime === null) {
    return { supportsBundleEvents: false };
  }
  const { supportsBundleEvents } = await import("@hot-updater/server/db");
  return { supportsBundleEvents: supportsBundleEvents(runtime) };
};

const collectBundles = async (
  getBundles: AnalyticsOverviewDependencies["getBundles"],
  pageSize: number,
): Promise<readonly Bundle[]> => {
  const bundles: Bundle[] = [];
  let page = 1;
  while (true) {
    const result = await getBundles({ limit: pageSize, page });
    bundles.push(...result.data);
    if (
      !result.pagination.hasNextPage ||
      page >= result.pagination.totalPages
    ) {
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
  const { supportsBundleEvents } = await import("@hot-updater/server/db");
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    !supportsBundleEvents(runtime)
  ) {
    throw new AnalyticsNotSupportedError();
  }

  const bundles = await collectBundles(getBundles, pageSize);
  const accumulator = createAnalyticsOverviewAccumulator(bundles);
  let offset = 0;
  while (true) {
    const page: InstallationPage = await runtime.searchInstallations(
      "",
      pageSize,
      offset,
    );
    accumulator.addInstallationPage(page.data);
    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.pagination.total) {
      return accumulator.finish();
    }
  }
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
