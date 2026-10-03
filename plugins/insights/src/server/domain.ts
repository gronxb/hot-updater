import type {
  BundleEventFailure,
  BundleEventFailureReason,
  BundleEventFailureStage,
  DatabaseBundleEventMetadata,
} from "./eventRow";
import type { InsightsScope } from "./modelTypes";

/**
 * Where an update failed and why, as a report carries it. Unknown values of
 * its sets read as `unknown`, so a newer client's failure still counts.
 */
export type BundleEventFailureInput = {
  readonly stage: BundleEventFailureStage;
  readonly reason: BundleEventFailureReason;
  readonly resource?: NonNullable<BundleEventFailure["resource"]>;
  /** The response status of an `http` failure. */
  readonly httpStatus?: number;
  readonly transport?: NonNullable<BundleEventFailure["transport"]>;
  /** The storage origin's error code, such as `ExpiredToken`. */
  readonly originCode?: string;
  /** Original client error text, bounded to fit the event payload. */
  readonly errorMessage?: string;
  readonly errorStack?: string;
  /** Android's `ApplicationExitInfo` reason for the process before this one. */
  readonly previousProcessExit?: string;
};

/**
 * The body of `POST /events`. Fields the server does not know are ignored, so
 * a newer client's report still records on an older server.
 */
export type CreateBundleEventRequestBase = {
  /**
   * The report's idempotency key: a canonical lowercase UUIDv7 that the
   * client creates once per report and repeats on every retry. The server
   * stores the report under it, so a retried report counts once, and a
   * report under an ID already stored changes nothing. Without it, the
   * server creates the ID, and a retry counts as another report.
   */
  readonly eventId?: string;
  readonly installId: string;
  readonly toBundleId: string;
  readonly userId?: string;
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprintHash: string | null;
  readonly sdkVersion?: string | null;
  readonly fromReleaseId: string | null;
  readonly toReleaseId: string | null;
};

type Movement = CreateBundleEventRequestBase & {
  readonly fromBundleId: string;
  readonly updateStrategy: "fingerprint" | "appVersion";
};

export type CreateBundleEventRequest =
  | (Movement & {
      readonly type: "UPDATE_DOWNLOADED";
      readonly metadata?: {
        /** How the bundle arrived. */
        readonly delivery?: NonNullable<
          DatabaseBundleEventMetadata["delivery"]
        >;
        /** A patch was tried, and the files or the archive came instead. */
        readonly patchFallback?: true;
      };
    })
  | (Movement & { readonly type: "UPDATE_APPLIED" })
  | (Movement & {
      readonly type: "RECOVERED";
      readonly metadata?: {
        /** Android's `ApplicationExitInfo` reason for the crashed process. */
        readonly previousProcessExit?: string;
      };
    })
  | (Movement & {
      /**
       * An update check, download, or install that failed: `fromBundleId`
       * runs, and `toBundleId` is the target (for a check, the running bundle).
       */
      readonly type: "UPDATE_FAILED";
      readonly metadata: { readonly failure: BundleEventFailureInput };
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
    | "UPDATE_DOWNLOADED"
    | "UPDATE_APPLIED"
    | "RECOVERED"
    | "UPDATE_FAILED"
    | "UNCHANGED";
  readonly fromBundleId: string | null;
  readonly toBundleId: string;
  readonly userId: string | null;
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly receivedAtMs: number;
  /** `UPDATE_FAILED`: where the update failed and why. */
  readonly failure?: BundleEventFailureInput;
  /** `UPDATE_DOWNLOADED`: how the bundle arrived, when the client said. */
  readonly delivery?: NonNullable<DatabaseBundleEventMetadata["delivery"]>;
  /** `UPDATE_DOWNLOADED`: a patch failed, and the files or the archive came instead. */
  readonly patchFallback?: true;
  /** `RECOVERED`: Android's reason the crashed process exited. */
  readonly previousProcessExit?: string;
};

export type InstallationHistoryRow = EventHistoryRow & {
  readonly type:
    | "UPDATE_DOWNLOADED"
    | "UPDATE_APPLIED"
    | "RECOVERED"
    | "UPDATE_FAILED";
  readonly fromBundleId: string;
};

export type InstallationRow = {
  readonly installId: string;
  readonly userId: string | null;
  readonly lastKnownBundleId: string;
  readonly pendingBundleId: string | null;
  readonly pendingReleaseId: string | null;
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

export type InsightsBundleSelection = InsightsScope & {
  readonly bundleId: string;
  /** `failed`: update failures that targeted the bundle. */
  readonly outcome: "downloaded" | "applied" | "recovered" | "failed";
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
    readonly downloadedReports: InsightsCountMeasurement;
    readonly appliedReports: InsightsCountMeasurement;
    readonly recoveredReports: InsightsCountMeasurement;
    readonly failedReports: InsightsCountMeasurement;
  };
};
