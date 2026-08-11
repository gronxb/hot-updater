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

export type AnalyticsProvider = {
  readonly mode: "bounded";
  readonly maxMatchingRows: number;
  appendBundleEvent(input: CreateBundleEventRequest): Promise<void>;
  getBundleEventSummary(bundleId: string): Promise<BundleEventSummary>;
  getBundleEventAnalytics(
    bundleId: string,
    window: BundleEventAnalyticsWindow,
    limit: number,
    offset: number,
  ): Promise<BundleEventAnalyticsResult>;
  getBundleEventOverview(): Promise<BundleEventOverview>;
  getActiveInstallationOverview(
    input: ActiveInstallationInput,
  ): Promise<ActiveInstallationOverview>;
  searchInstallations(
    query: string,
    limit: number,
    offset: number,
  ): Promise<OffsetPaginationResult<InstallationSearchRow>>;
  getInstallationHistory(
    installId: string,
    limit: number,
    offset: number,
  ): Promise<OffsetPaginationResult<InstallationHistoryRow>>;
};
