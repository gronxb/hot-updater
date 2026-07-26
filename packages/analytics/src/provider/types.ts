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
} from "../domain";

export type AnalyticsProviderMode =
  | {
      readonly mode: "bounded";
      readonly maxMatchingRows: number;
    }
  | { readonly mode: "dedicated" };

export type ReportedAnalyticsCapability = (
  | { readonly analytics: false }
  | ({ readonly analytics: true } & AnalyticsProviderMode)
) & {
  readonly analyticsQueries: boolean;
  readonly eventIngestion: boolean;
};

interface AnalyticsProviderOperations {
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
}

export type AnalyticsProvider = AnalyticsProviderOperations &
  AnalyticsProviderMode & {
    readonly resolveAvailability?: (
      signal: AbortSignal,
    ) => Promise<ReportedAnalyticsCapability>;
  };
