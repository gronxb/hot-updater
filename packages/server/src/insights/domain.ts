export type CreateBundleEventRequestBase = {
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
  readonly fromReleaseId: string | null;
  readonly toReleaseId: string | null;
};

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
      readonly type: "RELEASE_ADOPTED";
      readonly fromBundleId: string;
      readonly updateStrategy: "fingerprint" | "appVersion";
    })
  | (CreateBundleEventRequestBase & {
      readonly type: "UNCHANGED";
      readonly fromBundleId: null;
      readonly updateStrategy: null;
    });

export type BundleEventSummary = {
  readonly installed: number;
  readonly recovered: number;
};

export type BundleEventSummaryByBundle = BundleEventSummary & {
  readonly bundleId: string;
};

export type BundleEventInsightsWindow = "24h" | "7d" | "30d" | "all";
export type ActiveInstallationWindow = "24h" | "7d" | "30d";

export type InstallationSearchRow = {
  readonly installId: string;
  readonly username: string | null;
  readonly userId: string | null;
  readonly lastKnownBundleId: string;
  readonly latestStatus:
    | "UPDATE_APPLIED"
    | "RECOVERED"
    | "RELEASE_ADOPTED"
    | "UNCHANGED";
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly receivedAtMs: number;
};

export type InstallationHistoryRow = {
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
};

export type OffsetPaginationResult<TData> = {
  readonly data: readonly TData[];
  readonly pagination: {
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  };
};

export type InsightsSeriesPoint = {
  readonly bucketStartMs: number;
  readonly value: number;
};

export type InsightsCohortPoint = {
  readonly cohort: string;
  readonly value: number;
};

export type BundleEventInsightsResult = {
  readonly summary: BundleEventSummary;
  readonly series: {
    readonly installed: readonly InsightsSeriesPoint[];
    readonly recovered: readonly InsightsSeriesPoint[];
  };
  readonly cohorts: {
    readonly installed: readonly InsightsCohortPoint[];
    readonly recovered: readonly InsightsCohortPoint[];
  };
  readonly recentEvents: OffsetPaginationResult<InstallationHistoryRow>;
};

export type BundleEventOverview = {
  readonly trackedInstallations: number;
  readonly bundles: readonly {
    readonly bundleId: string;
    readonly installations: number;
  }[];
};

export type ActiveInstallationOverview = {
  readonly asOfMs: number;
  readonly window: ActiveInstallationWindow;
  readonly activeInstallations: number;
  readonly series: readonly InsightsSeriesPoint[];
  readonly bundleSeries: readonly {
    readonly bundleId: string;
    readonly series: readonly InsightsSeriesPoint[];
  }[];
  readonly bundles: readonly {
    readonly bundleId: string;
    readonly installations: number;
  }[];
};

export type ActiveInstallationInput = {
  readonly window: ActiveInstallationWindow;
  readonly userId?: string;
};
