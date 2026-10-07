import type { UpdateHttpResponse } from "@hot-updater/protocol";

import type {
  BundleEventChangeKind,
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
  readonly metadata?: { readonly httpResponse?: InsightsHttpResponse };
  readonly installId: string;
  readonly toBundleId: string;
  readonly userId?: string;
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprintHash: string | null;
  readonly sdkVersion?: string | null;
  /**
   * The bundle ID the native build ships as its built-in bundle. A report
   * whose running bundle is this one, with no Release, runs the built-in
   * bundle. Older SDKs leave it out.
   */
  readonly minBundleId?: string | null;
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
  | (Movement & { readonly type: "UPDATE_APPLIED" | "RECOVERED" })
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

/**
 * What a kept UNCHANGED report changed against its installation's previous
 * report: the running bundle or release, the app version, or the channel,
 * with the previous values; `first_seen` alone for an installation's first
 * report to this server.
 */
export type EventHistoryChange = {
  readonly kinds: readonly BundleEventChangeKind[];
  readonly previous?: {
    readonly bundleId: string;
    readonly releaseId: string | null;
    readonly appVersion: string;
    readonly channel: string;
    readonly minBundleId?: string;
  };
};

export type EventHistoryRow = {
  readonly toReleaseId?: string;
  readonly sdkVersion?: string;
  /** The native build's built-in bundle ID, when the SDK reported it. */
  readonly minBundleId?: string;
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
  readonly httpResponse?: InsightsHttpResponse;
  /** `UPDATE_FAILED`: where the update failed and why. */
  readonly failure?: BundleEventFailureInput;
  /** `UPDATE_DOWNLOADED`: how the bundle arrived, when the client said. */
  readonly delivery?: NonNullable<DatabaseBundleEventMetadata["delivery"]>;
  /** `UPDATE_DOWNLOADED`: a patch failed, and the files or the archive came instead. */
  readonly patchFallback?: true;
  /** `UNCHANGED`: what the report changed, the reason it was kept. */
  readonly change?: EventHistoryChange;
  /** A download or apply of a target already run or already downloaded: it counted nothing. */
  readonly late?: true;
  /** A launch or crash whose download report never arrived, counted with it. */
  readonly impliedDownload?: true;
};

export type InstallationHistoryRow = EventHistoryRow &
  (
    | {
        readonly type:
          | "UPDATE_DOWNLOADED"
          | "UPDATE_APPLIED"
          | "RECOVERED"
          | "UPDATE_FAILED";
        readonly fromBundleId: string;
      }
    | {
        readonly type: "UNCHANGED";
        readonly fromBundleId: null;
        readonly change: EventHistoryChange;
      }
  );

export type InsightsHttpResponse = UpdateHttpResponse & {
  readonly receivedAtMs: number;
};

export type InstallationRow = {
  readonly httpResponse?: InsightsHttpResponse;
  /** The native build's built-in bundle ID, when the SDK reported it. */
  readonly minBundleId?: string;
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
    /**
     * Download reports of the bundle, and in whole hours the downloads a
     * launch or crash implied when its download report never arrived.
     */
    readonly downloadedReports: InsightsCountMeasurement;
    readonly appliedReports: InsightsCountMeasurement;
    readonly recoveredReports: InsightsCountMeasurement;
    readonly failedReports: InsightsCountMeasurement;
  };
};
