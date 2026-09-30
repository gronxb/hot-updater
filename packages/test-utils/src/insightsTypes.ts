import type { DatabaseJsonObject } from "@hot-updater/plugin-core";

/**
 * The Insights plugin's row and model types, which its suites here exercise.
 * They mirror `@hot-updater/server/plugins/insights`, which test-utils cannot
 * import: the server's own tests import test-utils.
 */

export type BundleEventRow = {
  readonly id: string;
  readonly install_id: string;
  readonly user_id: string | null;
  readonly from_release_id: string | null;
  readonly to_release_id: string | null;
  readonly to_bundle_id: string;
  readonly platform: "ios" | "android";
  readonly app_version: string;
  readonly channel: string;
  readonly metadata: DatabaseJsonObject & {
    readonly cohort: string;
    readonly update_strategy: "fingerprint" | "appVersion" | null;
    readonly fingerprint_hash: string | null;
    readonly sdk_version: string | null;
    /** `UPDATE_FAILED`: where and why the update failed, and what else the client knew. */
    readonly failure?: DatabaseJsonObject & {
      readonly stage: "check" | "download" | "install" | "unknown";
      readonly reason:
        | "network"
        | "http"
        | "invalid_response"
        | "hash_mismatch"
        | "signature"
        | "patch"
        | "extract"
        | "storage"
        | "unknown";
      readonly resource?:
        | "catalog"
        | "artifact"
        | "manifest"
        | "file"
        | "patch"
        | "archive"
        | "unknown";
      readonly http_status?: number;
      readonly transport?:
        | "timeout"
        | "dns"
        | "tls"
        | "connection"
        | "offline"
        | "cancelled"
        | "unknown";
      readonly origin_code?: string;
      readonly previous_process_exit?: string;
    };
    readonly delivery?: "patch" | "manifest" | "archive" | "unknown";
    readonly patch_fallback?: boolean;
    readonly previous_process_exit?: string;
  };
  readonly received_at_ms: number;
} & (
  | { readonly type: "UPDATE_DOWNLOADED"; readonly from_bundle_id: string }
  | {
      readonly type: "UPDATE_APPLIED" | "RECOVERED";
      readonly from_bundle_id: string;
    }
  | { readonly type: "UPDATE_FAILED"; readonly from_bundle_id: string }
  | { readonly type: "UNCHANGED"; readonly from_bundle_id: null }
);

export interface InsightsEventCursor {
  readonly receivedAtMs: number;
  readonly id: string;
}

export interface InsightsScope {
  readonly platform: "ios" | "android";
  readonly channel: string;
}

/**
 * Raw event predicates; recovery is attributed to the source bundle. An
 * UNCHANGED report is kept as no event, so no filter names it.
 */
export type InsightsBundleEventFilter = InsightsScope &
  (
    | { readonly type: "RECOVERED"; readonly fromBundleId: string }
    | {
        readonly type: "UPDATE_DOWNLOADED" | "UPDATE_APPLIED" | "UPDATE_FAILED";
        readonly toBundleId: string;
      }
  );

export type InsightsEventFilter =
  | { readonly kind: "all" }
  | {
      readonly kind: "installationMovement";
      readonly installId: string;
    }
  | ({ readonly kind: "bundle" } & InsightsBundleEventFilter);

export interface InsightsRecordEventInput {
  readonly event: BundleEventRow;
}

export interface InsightsListEventsInput {
  readonly filter: InsightsEventFilter;
  readonly sinceMs?: number;
  readonly beforeReceivedAtMs: number;
  readonly after?: InsightsEventCursor;
  readonly limit: number;
}

export type InsightsFindLatestEventsInput =
  | { readonly installId: string }
  | {
      readonly userId: string;
      readonly afterInstallId?: string;
      readonly limit: number;
    };

export interface InsightsCountLatestEventsInput extends InsightsScope {
  /** A UTC day's start: latest events are counted by the day they fall in. */
  readonly sinceMs: number;
  /** Optional OR of one or two fixed predicates; count a matching event once. */
  readonly bundle?: readonly {
    readonly field: "from_bundle_id" | "to_bundle_id";
    readonly value: string;
    readonly types: readonly BundleEventRow["type"][];
  }[];
}

export interface InsightsCountEventsInput {
  readonly filter: InsightsBundleEventFilter;
  readonly sinceMs: number;
  readonly beforeReceivedAtMs: number;
}

export interface ReleaseReference {
  readonly releaseId: string;
  readonly platform: "ios" | "android";
  readonly channel: string;
}

export interface InsightsTimeRange {
  /** Inclusive UTC Unix timestamp in milliseconds. */
  readonly start: number;
  /** Exclusive UTC Unix timestamp in milliseconds. */
  readonly end: number;
}

export type InsightsCoverage =
  | { readonly kind: "complete"; readonly sinceMs: number }
  | { readonly kind: "partial"; readonly sinceMs: number | null };

export interface ReleaseActivityMetrics {
  readonly downloads: number;
  readonly launches: number;
  readonly failedLaunches: number;
  /** Omitted for lifetime-only bundle-row reads. */
  readonly uniqueUsers?: number;
  /** Daily points, present only for period reads. */
  readonly series?: readonly {
    readonly startMs: number;
    readonly launches: number;
    readonly failedLaunches: number;
  }[];
}

export type InsightsGetReleaseActivityInput =
  | {
      readonly releases: readonly ReleaseReference[];
      readonly timeRange?: InsightsTimeRange;
      readonly scope?: never;
    }
  | {
      readonly scope: InsightsScope;
      readonly timeRange: InsightsTimeRange;
      readonly releases?: never;
    };

export interface InsightsGetReleaseActivityResult {
  readonly coverage: InsightsCoverage;
  readonly data: readonly {
    readonly release?: ReleaseReference;
    readonly scope?: InsightsScope;
    readonly metrics: ReleaseActivityMetrics;
  }[];
  readonly measuredAtMs: number;
}

export interface InsightsGetAppUsageInput {
  readonly channel: string;
  readonly platform: "all" | "ios" | "android";
  readonly appVersion?: string;
  readonly timeRange: InsightsTimeRange;
  readonly intervalMs: number;
}

export interface InsightsGetAppUsageResult {
  readonly coverage: InsightsCoverage;
  readonly activeInstallations: number;
  readonly points: readonly {
    readonly startMs: number;
    readonly installations: number;
  }[];
  readonly appVersions: readonly string[];
  readonly versions: readonly {
    readonly name: string;
    readonly installations: number;
  }[];
  readonly platforms: readonly {
    readonly name: string;
    readonly installations: number;
  }[];
  readonly bundleDistribution: readonly {
    readonly appVersion: string;
    readonly platform: "ios" | "android";
    readonly releaseId: string | null;
    readonly installations: number;
  }[];
  readonly measuredAtMs: number;
}

export interface InsightsModel {
  /**
   * Persist the immutable event once. A private latest-event index, if used,
   * advances atomically for a greater (received_at_ms, id). Duplicate event
   * IDs are complete no-ops, whichever installation sends them.
   * Retry the identical prepared input after an ambiguous commit outcome.
   */
  recordEvent(input: InsightsRecordEventInput): Promise<void>;
  /**
   * Descending (received_at_ms, id), in [sinceMs ?? 0, beforeReceivedAtMs).
   * Apply filters and the exclusive cursor before limit (1..101). Return the
   * complete matching prefix; native continuation pages must not truncate it.
   * A global or bundle list may reject a range longer than 90 × 24 hours;
   * the server asks for older events with an earlier range instead.
   */
  listEvents(
    input: InsightsListEventsInput,
  ): Promise<readonly BundleEventRow[]>;
  /**
   * Choose each installation's greatest (received_at_ms, id) before filtering.
   * Exact installation lookup returns zero or one canonical event. User lookup
   * returns current membership ordered by UTF-8 installation ID, exclusive
   * afterInstallId and limit 1..101. Check lagging index candidates against
   * canonical state; newly indexed associations may temporarily be absent.
   */
  findLatestEvents(
    input: InsightsFindLatestEventsInput,
  ): Promise<readonly BundleEventRow[]>;
  /** Count latest events once per installation, then apply the supplied predicates. */
  countLatestEvents(input: InsightsCountLatestEventsInput): Promise<number>;
  /** Count accepted reports in [sinceMs, beforeReceivedAtMs), across all pages. */
  countEvents(input: InsightsCountEventsInput): Promise<number>;
  /** Read maintained release/scope summaries without scanning raw events. */
  getReleaseActivity(
    input: InsightsGetReleaseActivityInput,
  ): Promise<InsightsGetReleaseActivityResult>;
  /** Read maintained App usage summaries and latest-report distribution. */
  getAppUsage(
    input: InsightsGetAppUsageInput,
  ): Promise<InsightsGetAppUsageResult>;
}
