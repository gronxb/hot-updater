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
      readonly type: "UPDATE_APPLIED" | "RECOVERED" | "RELEASE_ADOPTED";
      readonly fromBundleId: string;
      readonly updateStrategy: "fingerprint" | "appVersion";
    })
  | (CreateBundleEventRequestBase & {
      readonly type: "UNCHANGED";
      readonly fromBundleId: null;
      readonly updateStrategy: null;
    });

export type ActiveInstallationWindow = "24h" | "7d" | "30d";

export type EventHistoryRow = {
  readonly id: string;
  readonly installId: string;
  readonly type:
    | "UPDATE_APPLIED"
    | "RECOVERED"
    | "RELEASE_ADOPTED"
    | "UNCHANGED";
  readonly fromBundleId: string | null;
  readonly toBundleId: string;
  readonly username: string | null;
  readonly userId: string | null;
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly receivedAtMs: number;
};

export type InstallationHistoryRow = EventHistoryRow & {
  readonly type: "UPDATE_APPLIED" | "RECOVERED";
  readonly fromBundleId: string;
};

export type InstallationRow = {
  readonly installId: string;
  readonly username: string | null;
  readonly userId: string | null;
  readonly lastKnownBundleId: string;
  readonly latestStatus: EventHistoryRow["type"];
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly receivedAtMs: number;
};

export type CursorPage<T> = {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
};

export type EventCursorPage<T extends EventHistoryRow> = CursorPage<T> & {
  readonly beforeReceivedAtMs: number;
};

export type InsightsScope = {
  readonly platform: "ios" | "android";
  readonly channel: string;
};

export type InsightsBundleSelection = InsightsScope & {
  readonly bundleId: string;
  readonly outcome: "applied" | "recovered" | "adopted";
};

export type InsightsCountMeasurement = {
  readonly count: number;
  readonly measuredAtMs: number;
};

export type ReportingOverview = InsightsScope & {
  readonly window: ActiveInstallationWindow;
  readonly sinceMs: number;
  readonly beforeReceivedAtMs: number;
  readonly reportingInstallations: InsightsCountMeasurement;
  readonly bundle?: {
    readonly bundleId: string;
    readonly reportingInstallations: InsightsCountMeasurement;
    readonly appliedReports: InsightsCountMeasurement;
    readonly recoveredReports: InsightsCountMeasurement;
    readonly adoptedReports: InsightsCountMeasurement;
  };
};
