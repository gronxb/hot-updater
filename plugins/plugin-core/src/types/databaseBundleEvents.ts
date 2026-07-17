export interface CreateBundleEventRequest {
  type: "UPDATE_APPLIED" | "RECOVERED";
  installId: string;
  fromBundleId: string;
  toBundleId: string;
  userId?: string;
  username?: string;
  platform: "ios" | "android";
  appVersion: string;
  channel: string;
  cohort: string;
  updateStrategy: "fingerprint" | "appVersion";
  fingerprintHash: string | null;
}

export interface BundleEventSummary {
  installed: number;
  recovered: number;
}

export type BundleEventAnalyticsWindow = "24h" | "7d" | "30d" | "all";

export interface InstallationSearchRow {
  installId: string;
  username: string | null;
  userId: string | null;
  lastKnownBundleId: string;
  latestStatus: "UPDATE_APPLIED" | "RECOVERED";
  platform: "ios" | "android";
  appVersion: string;
  channel: string;
  cohort: string;
  receivedAtMs: number;
}

export interface InstallationHistoryRow {
  id: string;
  type: "UPDATE_APPLIED" | "RECOVERED";
  fromBundleId: string;
  toBundleId: string;
  username: string | null;
  userId: string | null;
  platform: "ios" | "android";
  appVersion: string;
  channel: string;
  cohort: string;
  receivedAtMs: number;
}

export interface OffsetPaginationResult<TData> {
  data: TData[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}

export interface BundleEventAnalyticsResult {
  summary: BundleEventSummary;
  series: {
    installed: { bucketStartMs: number; value: number }[];
    recovered: { bucketStartMs: number; value: number }[];
  };
  cohorts: {
    installed: { cohort: string; value: number }[];
    recovered: { cohort: string; value: number }[];
  };
  recentEvents: OffsetPaginationResult<InstallationHistoryRow>;
}

export interface BundleEventOverview {
  trackedInstallations: number;
  bundles: { bundleId: string; installations: number }[];
}

export interface DatabaseBundleEventService<TContext = unknown> {
  appendBundleEvent(
    input: CreateBundleEventRequest,
    context?: TContext,
  ): Promise<void>;
  getBundleEventSummary(
    bundleId: string,
    context?: TContext,
  ): Promise<BundleEventSummary>;
  getBundleEventAnalytics(
    bundleId: string,
    window: BundleEventAnalyticsWindow,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<BundleEventAnalyticsResult>;
  getBundleEventOverview(context?: TContext): Promise<BundleEventOverview>;
  searchInstallations(
    query: string,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<OffsetPaginationResult<InstallationSearchRow>>;
  getInstallationHistory(
    installId: string,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<OffsetPaginationResult<InstallationHistoryRow>>;
}

export const databaseBundleEventService = Symbol.for(
  "@hot-updater/plugin-core/database-bundle-event-service",
);

export const databaseAnalyticsSupport = Symbol.for(
  "@hot-updater/plugin-core/database-analytics-support",
);
