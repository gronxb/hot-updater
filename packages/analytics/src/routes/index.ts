import type { HotUpdaterServerRoute } from "@hot-updater/server/internal/first-party-plugin";

import type { AnalyticsProvider } from "../provider";
import {
  createBundleQueryRoutes,
  type AnalyticsRouteOptions,
} from "./bundleQueries";
import { createIngestionRoute } from "./ingestion";
import { createInstallationQueryRoutes } from "./installationQueries";

export { EVENT_BODY_MAX_BYTES } from "./ingestion";

export function createAnalyticsRoutes(
  provider: AnalyticsProvider,
  options: AnalyticsRouteOptions,
): readonly HotUpdaterServerRoute[] {
  return Object.freeze([
    createIngestionRoute(provider),
    ...createBundleQueryRoutes(provider, options),
    ...createInstallationQueryRoutes(provider, options),
  ]);
}
