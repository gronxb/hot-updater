import type { BundleEventRow } from "./eventRow";

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
  /**
   * Points of each UTC day, or of each `intervalMs` from the period's start
   * on a release read that asks for one; present only for period reads.
   */
  readonly series?: readonly {
    readonly startMs: number;
    readonly downloads: number;
    readonly launches: number;
    readonly failedLaunches: number;
  }[];
}

export type InsightsGetReleaseActivityInput =
  | {
      readonly releases: readonly ReleaseReference[];
      readonly timeRange?: InsightsTimeRange;
      /**
       * Whole hours each series point spans, from `timeRange.start`, with
       * every point present; omitted, the series has a point per UTC day
       * with reports. Only with a `timeRange`.
       */
      readonly intervalMs?: number;
      readonly scope?: never;
    }
  | {
      readonly scope: InsightsScope;
      readonly timeRange: InsightsTimeRange;
      readonly intervalMs?: never;
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

/** Whole UTC days, at most 31, including the current unfinished day. */
export interface InsightsGetDistributionHistoryInput extends InsightsScope {
  readonly timeRange: InsightsTimeRange;
}

export interface InsightsGetDistributionHistoryResult {
  readonly coverage: InsightsCoverage;
  readonly measuredAtMs: number;
  readonly points: readonly {
    readonly startMs: number;
    readonly bundles: readonly {
      readonly appVersion: string;
      readonly releaseId: string | null;
      readonly bundleKind: "release" | "builtin" | "unknown";
      readonly installations: number;
    }[];
  }[];
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
  /** Daily last-observed running bundles, one per reporting installation. No historical backfill. */
  getDistributionHistory(
    input: InsightsGetDistributionHistoryInput,
  ): Promise<InsightsGetDistributionHistoryResult>;
  /** Read maintained App usage summaries and latest-report distribution. */
  getAppUsage(
    input: InsightsGetAppUsageInput,
  ): Promise<InsightsGetAppUsageResult>;
}
