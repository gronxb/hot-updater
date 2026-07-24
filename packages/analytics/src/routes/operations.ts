import type { HotUpdaterServerRoute } from "@hot-updater/server/internal/first-party-plugin";

import type { AnalyticsProvider } from "../provider";
import {
  getBundleEventAnalyticsOperation,
  getBundleEventOverviewOperation,
  getBundleEventSummaryOperation,
  type AnalyticsRouteOptions,
} from "./bundleOperations";
import { appendBundleEventOperation } from "./ingestionOperation";
import {
  getActiveInstallationOverviewOperation,
  getInstallationHistoryOperation,
  searchInstallationsOperation,
} from "./installationOperations";

export { EVENT_BODY_MAX_BYTES } from "./ingestionOperation";

export const analyticsOperationRegistry = Object.freeze({
  appendBundleEvent: appendBundleEventOperation,
  getBundleEventSummary: getBundleEventSummaryOperation,
  getBundleEventAnalytics: getBundleEventAnalyticsOperation,
  getBundleEventOverview: getBundleEventOverviewOperation,
  getActiveInstallationOverview: getActiveInstallationOverviewOperation,
  searchInstallations: searchInstallationsOperation,
  getInstallationHistory: getInstallationHistoryOperation,
});

export const ANALYTICS_OPERATION_NAMES = Object.freeze([
  analyticsOperationRegistry.appendBundleEvent.name,
  analyticsOperationRegistry.getBundleEventSummary.name,
  analyticsOperationRegistry.getBundleEventAnalytics.name,
  analyticsOperationRegistry.getBundleEventOverview.name,
  analyticsOperationRegistry.getActiveInstallationOverview.name,
  analyticsOperationRegistry.searchInstallations.name,
  analyticsOperationRegistry.getInstallationHistory.name,
]);

export const createAnalyticsRoutes = (
  provider: AnalyticsProvider,
  options: AnalyticsRouteOptions,
): readonly HotUpdaterServerRoute[] =>
  Object.freeze([
    analyticsOperationRegistry.appendBundleEvent.createRoute(provider),
    analyticsOperationRegistry.getBundleEventSummary.createRoute(
      provider,
      options,
    ),
    analyticsOperationRegistry.getBundleEventAnalytics.createRoute(
      provider,
      options,
    ),
    analyticsOperationRegistry.getBundleEventOverview.createRoute(
      provider,
      options,
    ),
    analyticsOperationRegistry.getActiveInstallationOverview.createRoute(
      provider,
      options,
    ),
    analyticsOperationRegistry.searchInstallations.createRoute(
      provider,
      options,
    ),
    analyticsOperationRegistry.getInstallationHistory.createRoute(
      provider,
      options,
    ),
  ]);
