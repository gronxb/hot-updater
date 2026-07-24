export interface CreateBundleEventRequestBase {
  readonly installId: string;
  readonly toBundleId: string;
  readonly userId?: string;
  readonly username?: string;
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprintHash: string | null;
  readonly sdkVersion?: string | null;
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
  readonly installed: number;
  readonly recovered: number;
}

export type BundleEventAnalyticsWindow = "24h" | "7d" | "30d" | "all";
export type ActiveInstallationWindow = "24h" | "7d" | "30d";

export interface InstallationSearchRow {
  readonly installId: string;
  readonly username: string | null;
  readonly userId: string | null;
  readonly lastKnownBundleId: string;
  readonly latestStatus: "UPDATE_APPLIED" | "RECOVERED" | "UNCHANGED";
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly receivedAtMs: number;
}

export interface InstallationHistoryRow {
  readonly id: string;
  readonly type: "UPDATE_APPLIED" | "RECOVERED";
  readonly fromBundleId: string;
  readonly toBundleId: string;
  readonly username: string | null;
  readonly userId: string | null;
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly receivedAtMs: number;
}

export interface OffsetPaginationResult<TData> {
  readonly data: readonly TData[];
  readonly pagination: {
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  };
}

export interface BundleEventAnalyticsResult {
  readonly summary: BundleEventSummary;
  readonly series: {
    readonly installed: readonly AnalyticsSeriesPoint[];
    readonly recovered: readonly AnalyticsSeriesPoint[];
  };
  readonly cohorts: {
    readonly installed: readonly AnalyticsCohortPoint[];
    readonly recovered: readonly AnalyticsCohortPoint[];
  };
  readonly recentEvents: OffsetPaginationResult<InstallationHistoryRow>;
}

export interface AnalyticsSeriesPoint {
  readonly bucketStartMs: number;
  readonly value: number;
}

export interface AnalyticsCohortPoint {
  readonly cohort: string;
  readonly value: number;
}

export interface BundleEventOverview {
  readonly trackedInstallations: number;
  readonly bundles: readonly {
    readonly bundleId: string;
    readonly installations: number;
  }[];
}

export interface ActiveInstallationOverview {
  readonly asOfMs: number;
  readonly window: ActiveInstallationWindow;
  readonly activeInstallations: number;
  readonly series: readonly AnalyticsSeriesPoint[];
  readonly bundleSeries: readonly {
    readonly bundleId: string;
    readonly series: readonly AnalyticsSeriesPoint[];
  }[];
  readonly bundles: readonly {
    readonly bundleId: string;
    readonly installations: number;
  }[];
}

export interface ActiveInstallationInput {
  readonly window: ActiveInstallationWindow;
  readonly userId?: string;
}
