import type { BundleEventRow } from "./databaseRows";

export type InsightsActiveWindow = "24h" | "7d" | "30d";
export type InsightsReportWindow = InsightsActiveWindow | "all";

/** Immutable, complete output from one committed source snapshot. */
export interface InsightsPublication {
  readonly id: string;
  readonly asOfMs: number;
  readonly completedAtMs: number;
  /** Provider-owned committed source/layout generation, not a time cutoff. */
  readonly sourceGeneration: string;
  readonly accuracy: "exact";
}

export type InsightsQueryFailure =
  | { readonly code: "index-not-ready" | "source-not-ready" }
  | { readonly code: "preparation-failed"; readonly jobId: string };

type InsightsUnpublished<TPublication> =
  | {
      /** These states require an actual durable job, reused across polling. */
      readonly state: "queued" | "preparing";
      readonly jobId: string;
      readonly previous: TPublication | null;
    }
  | {
      readonly state: "failed";
      readonly error: InsightsQueryFailure;
      readonly previous: TPublication | null;
    };

interface InsightsPageInput {
  /** Final response size, 1..100. The provider owns bounded lookahead. */
  readonly limit: number;
  readonly cursor?: string;
}

interface InsightsPageRows<TRow> {
  readonly rows: readonly TRow[];
  /** Only null proves exhaustion; never automatically refill a short page. */
  readonly nextCursor: string | null;
}

export type InsightsInstallationRow = Pick<
  BundleEventRow,
  | "id"
  | "install_id"
  | "user_id"
  | "username"
  | "to_bundle_id"
  | "type"
  | "platform"
  | "app_version"
  | "channel"
  | "cohort"
  | "received_at_ms"
>;

export type InsightsInstallationPageInput = InsightsPageInput &
  (
    | { readonly kind: "all" }
    | { readonly kind: "installation"; readonly installId: string }
    | {
        readonly kind: "contains";
        /** Nonempty historical install/user/username substring, JS lowercase. */
        readonly query: string;
        /** Pin a completed search, including a previous publication. */
        readonly publicationId?: string;
        /** Freshness selector only; excluded from the semantic lookup key. */
        readonly minAsOfMs?: number;
      }
  );

export interface InsightsInstallationPublication extends InsightsPublication {
  /** Exact matching installations in this publication, not a live total. */
  readonly total: number;
}

/**
 * Empty user search maps to all. All reads use the live latest projection; an
 * exact installation can also use an indexed latest-event point lookup.
 * Explicit installation IDs retain their full value, including an empty string.
 * Contains matches any historical alias and freezes both membership and latest
 * metadata at its publication's source generation. Order by install ID using JS
 * string comparison. Cursors bind the query and live/snapshot choice; snapshot
 * cursors also bind the publication. Live pages have no exact total.
 */
export type InsightsInstallationPage =
  | (InsightsPageRows<InsightsInstallationRow> & {
      readonly state: "ready";
      readonly consistency: "live";
      readonly observedAtMs: number;
    })
  | (InsightsPageRows<InsightsInstallationRow> & {
      readonly state: "ready";
      readonly consistency: "snapshot";
      readonly publication: InsightsInstallationPublication;
    })
  | InsightsUnpublished<InsightsInstallationPublication>
  | { readonly state: "expired"; readonly publicationId: string };

export type InsightsReportQuery =
  | {
      readonly kind: "bundleSummaries";
      /** Deduplicated, JS-string-sorted IDs; at most 100. One ID is batch one. */
      readonly bundleIds: readonly string[];
      readonly window: InsightsReportWindow;
    }
  | {
      readonly kind: "bundleDetail";
      readonly bundleId: string;
      readonly window: InsightsReportWindow;
    }
  | { readonly kind: "installationOverview" }
  | {
      readonly kind: "activeOverview";
      readonly window: InsightsActiveWindow;
      /** Exact latest identity in the rolling window, not a historical alias. */
      readonly userId?: string;
    };

export interface InsightsReportInput {
  readonly query: InsightsReportQuery;
  /**
   * Freshness selector, never part of the lookup key. Reuse one active job and
   * the latest publication for the canonical query and semantic/storage revision.
   */
  readonly minAsOfMs?: number;
}

export interface InsightsBundleSummary {
  /** Distinct installations applying to the bundle. */
  readonly installed: number;
  /** Distinct installations recovering from the bundle, counted independently. */
  readonly recovered: number;
}

export type InsightsReportPublication = InsightsPublication &
  (
    | {
        readonly kind: "bundleSummaries";
        /** One row per requested ID, including zeros; same canonical order. */
        readonly summary: readonly (InsightsBundleSummary & {
          readonly bundleId: string;
        })[];
      }
    | { readonly kind: "bundleDetail"; readonly summary: InsightsBundleSummary }
    | {
        readonly kind: "installationOverview";
        readonly summary: { readonly trackedInstallations: number };
      }
    | {
        readonly kind: "activeOverview";
        readonly summary: { readonly activeInstallations: number };
      }
  );

export type InsightsReportResult =
  | { readonly state: "ready"; readonly publication: InsightsReportPublication }
  | InsightsUnpublished<InsightsReportPublication>;

export type InsightsMovementMetric = "installed" | "recovered";

/** Fixed section choices, not an aggregation/query language. */
export type InsightsReportSection =
  | {
      readonly section: "movementSeries";
      readonly metric: InsightsMovementMetric;
    }
  | {
      readonly section: "movementCohorts";
      readonly metric: InsightsMovementMetric;
    }
  | { readonly section: "bundleDistribution" }
  | { readonly section: "activeSeries" }
  | { readonly section: "activeBundleSeries"; readonly bundleId?: string };

export type InsightsReportPageInput = InsightsPageInput &
  InsightsReportSection & { readonly publicationId: string };

export interface InsightsSeriesRow {
  readonly bucketStartMs: number;
  readonly value: number;
}

/**
 * Each page belongs to the requested immutable publication; expiration requires
 * restarting, never silently switching publications. Cursors bind publication,
 * section, metric/bundle filter and ordering. No server-side raw regrouping.
 *
 * Movement sections belong to bundleDetail. Series use ascending UTC buckets
 * (hourly for 24h, daily otherwise), including zero buckets; all-time starts at
 * that metric's oldest relevant UTC day. Cohorts use ascending JS string order.
 * Distribution belongs to installationOverview/activeOverview, ordered by count
 * descending then bundle ID ascending. Active series use ascending rolling
 * buckets at asOfMs. Active bundle rows order by total bucket observations
 * descending, bundle ID ascending, then bucket ascending, including zero buckets.
 */
export type InsightsReportPage =
  | ({ readonly state: "ready"; readonly publicationId: string } & (
      | (InsightsPageRows<InsightsSeriesRow> & {
          readonly section: "movementSeries";
          readonly metric: InsightsMovementMetric;
        })
      | (InsightsPageRows<{
          readonly cohort: string;
          readonly value: number;
        }> & {
          readonly section: "movementCohorts";
          readonly metric: InsightsMovementMetric;
        })
      | (InsightsPageRows<{
          readonly bundleId: string;
          readonly installations: number;
        }> & { readonly section: "bundleDistribution" })
      | (InsightsPageRows<InsightsSeriesRow> & {
          readonly section: "activeSeries";
        })
      | (InsightsPageRows<InsightsSeriesRow & { readonly bundleId: string }> & {
          readonly section: "activeBundleSeries";
        })
    ))
  | { readonly state: "expired"; readonly publicationId: string };
