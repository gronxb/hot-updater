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

export interface InsightsReadVersions {
  /** Null only when layout inspection cannot identify a version. */
  readonly schemaVersion: string | null;
  /** Null only when layout inspection cannot identify a version. */
  readonly storageVersion: string | null;
  /** Null for raw event reads or when no projection generation is knowable. */
  readonly projectionGeneration: string | null;
  /** Null only for a failed pre-layout read which cannot inspect the source. */
  readonly sourceGeneration: string | null;
}

export interface InsightsCommittedReadVersions extends InsightsReadVersions {
  readonly schemaVersion: string;
  readonly storageVersion: string;
  readonly sourceGeneration: string;
}

export interface InsightsProjectedReadVersions extends InsightsCommittedReadVersions {
  readonly projectionGeneration: string;
}

export interface InsightsSourceReadVersions extends InsightsCommittedReadVersions {
  readonly projectionGeneration: null;
}

export interface InsightsReservedReadVersions extends InsightsReadVersions {
  /** A preparation job always freezes a real committed source generation. */
  readonly sourceGeneration: string;
}

export interface InsightsPreparationJob {
  /** Durable ID reused when the same semantic query is polled. */
  readonly id: string;
}

export type InsightsReadFailure =
  | {
      readonly code:
        | "schema-not-ready"
        | "storage-not-ready"
        | "index-not-ready"
        | "source-not-ready";
    }
  | {
      readonly code: "preparation-failed" | "migration-poison";
      readonly jobId: string;
    }
  | { readonly code: "storage-corruption" };

/**
 * `preparing` always names a real durable job. Usable old data plus an active
 * refresh is `stale`; it is never reported as preparing or as a current zero.
 */
export interface InsightsReadyRead<
  TData,
  TVersions extends InsightsCommittedReadVersions =
    InsightsCommittedReadVersions,
> {
  readonly state: "ready";
  readonly versions: TVersions;
  readonly data: TData;
}

export interface InsightsPreparingRead {
  readonly state: "preparing";
  readonly versions: InsightsReservedReadVersions;
  readonly job: InsightsPreparationJob;
}

export interface InsightsStaleRead<
  TData,
  TVersions extends InsightsCommittedReadVersions =
    InsightsCommittedReadVersions,
> {
  readonly state: "stale";
  readonly versions: TVersions;
  /** Immutable previous publication/data while its successor runs. */
  readonly data: TData;
  readonly refresh: InsightsPreparationJob;
}

export interface InsightsFailedRead {
  readonly state: "failed";
  readonly versions: InsightsReadVersions;
  readonly error: InsightsReadFailure;
}

export type InsightsLiveReadResult<
  TData,
  TVersions extends InsightsCommittedReadVersions =
    InsightsCommittedReadVersions,
> =
  | InsightsReadyRead<TData, TVersions>
  | InsightsPreparingRead
  | InsightsFailedRead;

export type InsightsPublishedReadResult<
  TData,
  TVersions extends InsightsCommittedReadVersions =
    InsightsCommittedReadVersions,
> =
  | InsightsReadyRead<TData, TVersions>
  | InsightsPreparingRead
  | InsightsStaleRead<TData, TVersions>
  | InsightsFailedRead;

export type InsightsTotal =
  | {
      readonly state: "exact";
      readonly value: number;
      readonly sourceGeneration: string;
    }
  | { readonly state: "pending"; readonly jobId: string }
  | { readonly state: "unavailable" };

export type InsightsPageConsistency =
  | {
      readonly kind: "live";
      /** New view requests choose a fresh cutoff; cursors retain this one. */
      readonly cutoff: {
        readonly kind: "event-time";
        readonly beforeReceivedAtMs: number;
      };
    }
  | {
      readonly kind: "live";
      readonly cutoff: {
        readonly kind: "projection";
        readonly observedAtMs: number;
        readonly projectionGeneration: string;
      };
    }
  | {
      readonly kind: "snapshot";
      readonly cutoff: {
        readonly kind: "publication";
        readonly publication: InsightsPublication;
      };
    };

export interface InsightsPageData<TRow> {
  readonly data: readonly TRow[];
  /** Only null proves exhaustion; a short or empty page may continue. */
  readonly nextCursor: string | null;
  /** Must equal `nextCursor !== null`. */
  readonly hasNext: boolean;
  readonly consistency: InsightsPageConsistency;
  readonly total: InsightsTotal;
}

export type InsightsEventPageData = Omit<
  InsightsPageData<BundleEventRow>,
  "consistency"
> & {
  readonly consistency: Extract<
    InsightsPageConsistency,
    { readonly cutoff: { readonly kind: "event-time" } }
  >;
};

export type InsightsLiveInstallationPageData = Omit<
  InsightsPageData<InsightsInstallationRow>,
  "consistency"
> & {
  readonly consistency: Extract<
    InsightsPageConsistency,
    { readonly cutoff: { readonly kind: "projection" } }
  >;
};

export type InsightsPublishedInstallationPageData = Omit<
  InsightsPageData<InsightsInstallationRow>,
  "consistency" | "total"
> & {
  readonly consistency: Extract<
    InsightsPageConsistency,
    { readonly kind: "snapshot" }
  >;
  readonly total: Extract<InsightsTotal, { readonly state: "exact" }>;
};

export interface InsightsPageInput {
  /** Final response size, 1..100. The provider owns bounded lookahead. */
  readonly limit: number;
  readonly cursor?: string;
}

export type InsightsPageEventsSelector =
  | { readonly kind: "all" }
  | { readonly kind: "installationId"; readonly installId: string }
  | { readonly kind: "bundleId"; readonly bundleId: string };

/**
 * `all` includes all four public event types. Installation and bundle history
 * include movement (`UPDATE_APPLIED` and `RECOVERED`) only. The lower time bound
 * is inclusive and the fixed upper cutoff is exclusive.
 */
export type InsightsPageEventsInput = InsightsPageInput & {
  readonly selector: InsightsPageEventsSelector;
  readonly sinceReceivedAtMs?: number;
  readonly beforeReceivedAtMs: number;
};

export type InsightsPageEventsResult = InsightsLiveReadResult<
  InsightsEventPageData,
  InsightsSourceReadVersions
>;

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

export type InsightsInstallationSelector =
  | { readonly kind: "all" }
  | { readonly kind: "installationId"; readonly installId: string }
  | {
      readonly kind: "userId";
      /** Exact, case-sensitive whole-string historical user-ID match. */
      readonly userId: string;
      /** Pin a completed lookup, including a previous publication. */
      readonly publicationId?: string;
      /** Freshness selector only; excluded from the semantic lookup key. */
      readonly minAsOfMs?: number;
    }
  | {
      readonly kind: "contains";
      /** Nonempty historical install/user/username substring, JS lowercase. */
      readonly query: string;
      /** Pin a completed search, including a previous publication. */
      readonly publicationId?: string;
      /** Freshness selector only; excluded from the semantic lookup key. */
      readonly minAsOfMs?: number;
    };

export type InsightsInstallationPageInput =
  | (InsightsPageInput & Extract<InsightsInstallationSelector, { kind: "all" }>)
  | ({ readonly limit: number; readonly cursor?: never } & Extract<
      InsightsInstallationSelector,
      { kind: "installationId" }
    >)
  | (InsightsPageInput &
      Extract<InsightsInstallationSelector, { kind: "userId" | "contains" }>);

export type InsightsLiveInstallationPageInput = Extract<
  InsightsInstallationPageInput,
  { readonly kind: "all" | "installationId" }
>;

export type InsightsPublishedInstallationPageInput = Extract<
  InsightsInstallationPageInput,
  { readonly kind: "userId" | "contains" }
>;

type DistributiveOmit<TValue, TKey extends PropertyKey> = TValue extends unknown
  ? Omit<TValue, TKey>
  : never;

export type InsightsInitialPublishedInstallationPageInput = DistributiveOmit<
  InsightsPublishedInstallationPageInput,
  "cursor" | "publicationId"
> & {
  readonly cursor?: never;
  readonly publicationId?: never;
};

export type InsightsPinnedInstallationPageInput = DistributiveOmit<
  InsightsPublishedInstallationPageInput,
  "cursor" | "publicationId"
> & {
  readonly cursor?: never;
  readonly publicationId: string;
};

export type InsightsPublishedInstallationContinuationInput = DistributiveOmit<
  InsightsPublishedInstallationPageInput,
  "cursor"
> & {
  readonly cursor: string;
};

/**
 * `installationId` is a live exact lookup returning current metadata. `userId`
 * and `contains` match historical aliases, then freeze their membership and
 * latest metadata at the returned publication's source generation. Every
 * multi-row page orders by the raw bytes of
 * SHA-256(UTF-8(JSON.stringify(full installation ID))). Providers retain the
 * full ID and verify it on every keyed read/write; a digest/full-ID mismatch is
 * storage corruption, never an alternate identity.
 */
export type InsightsInstallationPage =
  | InsightsLiveReadResult<
      InsightsLiveInstallationPageData,
      InsightsProjectedReadVersions
    >
  | InsightsPublishedReadResult<
      InsightsPublishedInstallationPageData,
      InsightsProjectedReadVersions
    >
  | { readonly state: "expired"; readonly publicationId: string };

export type InsightsLiveInstallationPage = InsightsLiveReadResult<
  InsightsLiveInstallationPageData,
  InsightsProjectedReadVersions
>;

export type InsightsPublishedInstallationPage =
  | InsightsPublishedReadResult<
      InsightsPublishedInstallationPageData,
      InsightsProjectedReadVersions
    >
  | { readonly state: "expired"; readonly publicationId: string };

export type InsightsInitialPublishedInstallationPage =
  InsightsPublishedReadResult<
    InsightsPublishedInstallationPageData,
    InsightsProjectedReadVersions
  >;

export type InsightsPinnedInstallationPage =
  | InsightsReadyRead<
      InsightsPublishedInstallationPageData,
      InsightsProjectedReadVersions
    >
  | InsightsFailedRead
  | { readonly state: "expired"; readonly publicationId: string };

export type InsightsPublishedInstallationContinuation =
  | InsightsReadyRead<
      InsightsPublishedInstallationPageData,
      InsightsProjectedReadVersions
    >
  | InsightsStaleRead<
      InsightsPublishedInstallationPageData,
      InsightsProjectedReadVersions
    >
  | InsightsFailedRead
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
      /** Exact, case-sensitive latest user identity. */
      readonly userId?: string;
    };

export interface InsightsReportInput {
  readonly query: InsightsReportQuery;
  /** Freshness selector, never part of the semantic lookup key. */
  readonly minAsOfMs?: number;
}

export interface InsightsBundleSummary {
  readonly installed: number;
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

export type InsightsReportResult = InsightsPublishedReadResult<
  InsightsReportPublication,
  InsightsProjectedReadVersions
>;

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

/**
 * The model binds every cursor to its durable database namespace and this
 * section's committed ordering revision before reading publication storage.
 */
export type InsightsReportPageInput = InsightsPageInput &
  InsightsReportSection & { readonly publicationId: string };

export interface InsightsSeriesRow {
  readonly bucketStartMs: number;
  readonly value: number;
}

/**
 * Every section has one fixed publication order. String comparisons use
 * JavaScript UTF-16 code-unit order (`<`/`>`), never `localeCompare` or native
 * database collation. Movement and active series are ascending by bucket and
 * include every bucket in the requested interval, including zero values.
 * Movement cohorts are ascending by complete cohort label. Bundle distribution
 * is installations descending, then complete bundle ID ascending. Unfiltered
 * active bundle series ranks bundles by total bucket observations descending,
 * then complete bundle ID ascending, and emits each ranked bundle's buckets in
 * ascending order, including zeros. A filtered bundle uses bucket order only.
 */
export type InsightsReportPageData =
  | (InsightsPageData<InsightsSeriesRow> & {
      readonly section: "movementSeries";
      readonly metric: InsightsMovementMetric;
    })
  | (InsightsPageData<{ readonly cohort: string; readonly value: number }> & {
      readonly section: "movementCohorts";
      readonly metric: InsightsMovementMetric;
    })
  | (InsightsPageData<{
      readonly bundleId: string;
      readonly installations: number;
    }> & { readonly section: "bundleDistribution" })
  | (InsightsPageData<InsightsSeriesRow> & {
      readonly section: "activeSeries";
    })
  | (InsightsPageData<InsightsSeriesRow & { readonly bundleId: string }> & {
      readonly section: "activeBundleSeries";
    });

type WithPublishedPageContract<TPage> = TPage extends unknown
  ? Omit<TPage, "consistency" | "total"> & {
      readonly consistency: Extract<
        InsightsPageConsistency,
        { readonly kind: "snapshot" }
      >;
      readonly total: Extract<InsightsTotal, { readonly state: "exact" }>;
    }
  : never;

export type InsightsPublishedReportPageData =
  WithPublishedPageContract<InsightsReportPageData>;

/** Expiration asks the caller to restart; it never switches publications. */
export type InsightsReportPage =
  | InsightsReadyRead<
      InsightsPublishedReportPageData,
      InsightsProjectedReadVersions
    >
  | InsightsFailedRead
  | { readonly state: "expired"; readonly publicationId: string };
