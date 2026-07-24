import type { HotUpdaterContext } from "@hot-updater/plugin-core";

import type {
  ActiveInstallationInput,
  ActiveInstallationOverview,
  BundleEventAnalyticsResult,
  BundleEventAnalyticsWindow,
  BundleEventOverview,
  BundleEventSummary,
  CreateBundleEventRequest,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
} from "./domain";
import type { AnalyticsProvider } from "./provider";
import { analyticsOperationRegistry } from "./routes/operations";

export interface AnalyticsAPI<TContext = unknown> {
  appendBundleEvent(
    input: CreateBundleEventRequest,
    context?: HotUpdaterContext<TContext>,
  ): Promise<void>;
  getBundleEventSummary(
    bundleId: string,
    context?: HotUpdaterContext<TContext>,
  ): Promise<BundleEventSummary>;
  getBundleEventAnalytics(
    bundleId: string,
    window: BundleEventAnalyticsWindow,
    limit: number,
    offset: number,
    context?: HotUpdaterContext<TContext>,
  ): Promise<BundleEventAnalyticsResult>;
  getBundleEventOverview(
    context?: HotUpdaterContext<TContext>,
  ): Promise<BundleEventOverview>;
  getActiveInstallationOverview(
    input: ActiveInstallationInput,
    context?: HotUpdaterContext<TContext>,
  ): Promise<ActiveInstallationOverview>;
  searchInstallations(
    query: string,
    limit: number,
    offset: number,
    context?: HotUpdaterContext<TContext>,
  ): Promise<OffsetPaginationResult<InstallationSearchRow>>;
  getInstallationHistory(
    installId: string,
    limit: number,
    offset: number,
    context?: HotUpdaterContext<TContext>,
  ): Promise<OffsetPaginationResult<InstallationHistoryRow>>;
}

export type AnalyticsFeatureAvailable<TContext = unknown> = Readonly<
  AnalyticsAPI<TContext> & { readonly status: "available" }
>;

export type AnalyticsFeatureUnavailable = Readonly<{
  readonly reason: "missing-provider-capability";
  readonly status: "unavailable";
}>;

export type AnalyticsFeature<TContext = unknown> =
  | AnalyticsFeatureAvailable<TContext>
  | AnalyticsFeatureUnavailable;

export const createAnalyticsFeature = <TContext>(
  provider: AnalyticsProvider,
): AnalyticsFeatureAvailable<TContext> => {
  const append =
    analyticsOperationRegistry.appendBundleEvent.createRuntimeMethod(provider);
  const active =
    analyticsOperationRegistry.getActiveInstallationOverview.createRuntimeMethod(
      provider,
    );
  const eventAnalytics =
    analyticsOperationRegistry.getBundleEventAnalytics.createRuntimeMethod(
      provider,
    );
  const overview =
    analyticsOperationRegistry.getBundleEventOverview.createRuntimeMethod(
      provider,
    );
  const summary =
    analyticsOperationRegistry.getBundleEventSummary.createRuntimeMethod(
      provider,
    );
  const history =
    analyticsOperationRegistry.getInstallationHistory.createRuntimeMethod(
      provider,
    );
  const search =
    analyticsOperationRegistry.searchInstallations.createRuntimeMethod(
      provider,
    );
  return Object.freeze({
    status: "available",
    appendBundleEvent(input, _context) {
      return append(input);
    },
    getActiveInstallationOverview(input, _context) {
      return active(input);
    },
    getBundleEventAnalytics(bundleId, window, limit, offset, _context) {
      return eventAnalytics(bundleId, window, limit, offset);
    },
    getBundleEventOverview(_context) {
      return overview();
    },
    getBundleEventSummary(bundleId, _context) {
      return summary(bundleId);
    },
    getInstallationHistory(installId, limit, offset, _context) {
      return history(installId, limit, offset);
    },
    searchInstallations(query, limit, offset, _context) {
      return search(query, limit, offset);
    },
  } satisfies AnalyticsFeatureAvailable<TContext>);
};

export const unavailableAnalyticsFeature =
  Object.freeze<AnalyticsFeatureUnavailable>({
    reason: "missing-provider-capability",
    status: "unavailable",
  });
