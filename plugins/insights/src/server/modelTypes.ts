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

/** One bundle filter's stored events in each interval of a time range. */
export interface InsightsCountEventSeriesInput {
  readonly filter: InsightsBundleEventFilter;
  /** Whole UTC hours, at most 90 days, that a whole number of intervals fill. */
  readonly timeRange: InsightsTimeRange;
  /** Whole hours each point spans, from `timeRange.start`. */
  readonly intervalMs: number;
}

/** Stored events in [startMs, startMs + intervalMs). */
export interface InsightsEventSeriesPoint {
  readonly startMs: number;
  readonly events: number;
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

/**
 * A release's counts since its first report, from its lifetime counters,
 * which are kept.
 */
export interface ReleaseActivityMetrics {
  readonly downloads: number;
  readonly launches: number;
  readonly failedLaunches: number;
}

export interface InsightsGetReleaseActivityInput {
  /** 1 to 100 releases. */
  readonly releases: readonly ReleaseReference[];
}

export interface InsightsGetReleaseActivityResult {
  readonly data: readonly {
    readonly release: ReleaseReference;
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
  /**
   * A bundle filter's stored events in each interval, every interval
   * present in order, from the hourly counts that `countEvents` reads.
   */
  countEventSeries(
    input: InsightsCountEventSeriesInput,
  ): Promise<readonly InsightsEventSeriesPoint[]>;
  /** Releases' lifetime counters, without scanning raw events. */
  getReleaseActivity(
    input: InsightsGetReleaseActivityInput,
  ): Promise<InsightsGetReleaseActivityResult>;
  /** Read maintained App usage summaries and latest-report distribution. */
  getAppUsage(
    input: InsightsGetAppUsageInput,
  ): Promise<InsightsGetAppUsageResult>;
}
