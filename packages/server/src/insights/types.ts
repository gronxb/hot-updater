import type {
  ActiveInstallationInput,
  ActiveInstallationOverview,
  BundleEventInsightsResult,
  BundleEventInsightsWindow,
  BundleEventOverview,
  BundleEventSummary,
  BundleEventSummaryByBundle,
  CreateBundleEventRequest,
  EventHistoryRow,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
} from "./domain";

export type InsightsProvider = {
  readonly mode: "bounded";
  readonly maxMatchingRows: number;
  appendBundleEvent(input: CreateBundleEventRequest): Promise<void>;
  getBundleEventSummary(bundleId: string): Promise<BundleEventSummary>;
  getBundleEventSummaries(
    bundleIds: readonly string[],
    window: BundleEventInsightsWindow,
  ): Promise<readonly BundleEventSummaryByBundle[]>;
  getBundleEventInsights(
    bundleId: string,
    window: BundleEventInsightsWindow,
    limit: number,
    offset: number,
  ): Promise<BundleEventInsightsResult>;
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
  getEventHistory(
    limit: number,
    offset: number,
  ): Promise<OffsetPaginationResult<EventHistoryRow>>;
};
