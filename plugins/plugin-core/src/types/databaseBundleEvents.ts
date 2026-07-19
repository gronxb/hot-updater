interface CreateBundleEventRequestBase {
  readonly installId: string;
  readonly toBundleId: string;
  readonly userId?: string;
  readonly username?: string;
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprintHash: string | null;
}

export type CreateBundleEventRequest =
  | (CreateBundleEventRequestBase & {
      readonly type: "UPDATE_APPLIED";
      readonly fromBundleId: string;
      readonly updateStrategy: "fingerprint" | "appVersion";
    })
  | (CreateBundleEventRequestBase & {
      readonly type: "RECOVERED";
      readonly fromBundleId: string;
      readonly updateStrategy: "fingerprint" | "appVersion";
    })
  | (CreateBundleEventRequestBase & {
      readonly type: "UNCHANGED";
      readonly fromBundleId: null;
      readonly updateStrategy: null;
    });

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

export type ActiveInstallationWindow = "24h" | "7d" | "30d";

export interface ActiveInstallationOverview {
  readonly asOfMs: number;
  readonly window: ActiveInstallationWindow;
  readonly activeInstallations: number;
  readonly series: readonly {
    readonly bucketStartMs: number;
    readonly value: number;
  }[];
  readonly bundleSeries: readonly {
    readonly bundleId: string;
    readonly series: readonly {
      readonly bucketStartMs: number;
      readonly value: number;
    }[];
  }[];
  readonly bundles: readonly {
    readonly bundleId: string;
    readonly installations: number;
  }[];
}

export interface DatabaseBundleEventService {
  appendBundleEvent(input: CreateBundleEventRequest): Promise<void>;
  getBundleEventSummary(bundleId: string): Promise<BundleEventSummary>;
  getBundleEventAnalytics(
    bundleId: string,
    window: BundleEventAnalyticsWindow,
    limit: number,
    offset: number,
  ): Promise<BundleEventAnalyticsResult>;
  getBundleEventOverview(): Promise<BundleEventOverview>;
  getActiveInstallationOverview(input: {
    readonly window: ActiveInstallationWindow;
    readonly userId?: string;
  }): Promise<ActiveInstallationOverview>;
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

export const databaseBundleEventService = Symbol.for(
  "@hot-updater/plugin-core/database-bundle-event-service",
);

export const databaseAnalyticsSupport = Symbol.for(
  "@hot-updater/plugin-core/database-analytics-support",
);
