import type { BundleRowUpdate, ReleaseRowUpdate } from "./databaseOperations";
import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ApiKeyRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "./databaseRows";
import type {
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
} from "./index";

export interface BundleModelQuery {
  readonly where?: DatabaseBundleQueryWhere;
  readonly limit: number;
  readonly offset: number;
  readonly orderBy: DatabaseBundleQueryOrder;
}

export interface BundleModel {
  findById(id: string): Promise<BundleRow | null>;
  findMany(query: BundleModelQuery): Promise<readonly BundleRow[]>;
  count(where?: DatabaseBundleQueryWhere): Promise<number>;
}

export interface BundlePatchModel {
  findByBundleIds(
    bundleIds: readonly string[],
  ): Promise<readonly BundlePatchRow[]>;
}

export interface ReleaseModel {
  findById(id: string): Promise<ReleaseRow | null>;
  findMany(input: {
    readonly afterReleaseId?: string;
    readonly beforeReleaseId?: string;
    readonly bundleId?: string;
    readonly channelId?: string;
    readonly enabled?: boolean;
    readonly platform?: "ios" | "android";
    readonly targetAppVersion?: string;
    readonly limit: number;
  }): Promise<readonly ReleaseRow[]>;
  findManyByScope(input: {
    readonly scopeKey: string;
    readonly afterReleaseId?: string;
    readonly limit: number;
    readonly consistency: "strong";
  }): Promise<readonly ReleaseRow[]>;
}

export interface ReleaseCatalogModel {
  findByScopeKey(scopeKey: string): Promise<ReleaseCatalogRow | null>;
  findMany(input: {
    readonly afterScopeKey?: string;
    readonly limit: number;
  }): Promise<readonly ReleaseCatalogRow[]>;
}

export interface InsightsEventCursor {
  readonly receivedAtMs: number;
  readonly id: string;
}

export interface InsightsScope {
  readonly platform: "ios" | "android";
  readonly channel: string;
}

/** Raw event predicates; recovery is attributed to the source bundle. */
export type InsightsBundleEventFilter = InsightsScope &
  (
    | { readonly type: "RECOVERED"; readonly fromBundleId: string }
    | {
        readonly type: "UPDATE_DOWNLOADED" | "UPDATE_APPLIED" | "UNCHANGED";
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

export interface ReleaseActivityTimeRange {
  /** Inclusive UTC Unix timestamp in milliseconds, aligned to an hour. */
  readonly start: number;
  /** Exclusive UTC Unix timestamp in milliseconds, aligned to an hour. */
  readonly end: number;
}

export type InsightsHistoryCoverage =
  | { readonly kind: "complete"; readonly sinceMs: number }
  | { readonly kind: "partial"; readonly sinceMs: number | null };

export interface ReleaseActivity {
  readonly release: ReleaseReference;
  readonly summary: {
    readonly activeInstallations: number;
    readonly pendingInstallations: number;
    readonly downloadedInstallations: number;
    readonly recoveredInstallations: number;
  };
  readonly series?: readonly {
    readonly startMs: number;
    readonly downloadedReports: number;
    readonly appliedReports: number;
    readonly recoveredReports: number;
  }[];
  readonly measuredAtMs: number;
}

export interface InsightsGetReleaseActivityInput {
  readonly releases: readonly ReleaseReference[];
  readonly timeRange?: ReleaseActivityTimeRange;
}

export interface InsightsGetReleaseActivityResult {
  readonly coverage: InsightsHistoryCoverage;
  readonly data: readonly ReleaseActivity[];
}

export interface InsightsLifetimeKey {
  readonly release: ReleaseReference;
  readonly installId: string;
  readonly metric: "downloaded" | "recovered";
}

export interface InsightsCurrentDelta {
  readonly release: ReleaseReference;
  readonly metric: "active" | "pending";
  readonly delta: -1 | 1;
}

export interface PreparedInsightsEvent {
  readonly event: BundleEventRow;
  readonly expectedRevision: string;
  readonly nextState: string;
  readonly currentDeltas: readonly InsightsCurrentDelta[];
  readonly firstLifetime: InsightsLifetimeKey | null;
  readonly hourly: {
    readonly release: ReleaseReference;
    readonly hourStartMs: number;
    readonly metric: "downloaded" | "applied" | "recovered";
  } | null;
}

export interface InsightsRecordContext {
  readonly revision: string;
  readonly state: string | null;
  readonly lifetimeExists: boolean;
}

export interface InsightsStorageAdapter {
  readRecordContext(input: {
    readonly installId: string;
    readonly lifetimeKey: InsightsLifetimeKey | null;
  }): Promise<InsightsRecordContext>;
  commitPreparedEvent(
    input: PreparedInsightsEvent,
  ): Promise<
    | { readonly status: "committed" }
    | { readonly status: "duplicate" }
    | { readonly status: "conflict" }
  >;
  getReleaseActivity: InsightsModel["getReleaseActivity"];
}

export interface InsightsModel {
  /**
   * Persist the immutable event once. A private latest-event index, if used,
   * advances atomically for a greater (received_at_ms, id). Duplicate event
   * IDs are complete no-ops.
   * Retry the identical prepared input after an ambiguous commit outcome.
   */
  recordEvent(input: InsightsRecordEventInput): Promise<void>;
  /**
   * Descending (received_at_ms, id), in [sinceMs ?? 0, beforeReceivedAtMs).
   * Apply filters and the exclusive cursor before limit (1..101). Return the
   * complete matching prefix; native continuation pages must not truncate it.
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
   * Read materialized release summaries and optional hourly report buckets.
   * This method must never scan raw events to complete the result.
   */
  getReleaseActivity(
    input: InsightsGetReleaseActivityInput,
  ): Promise<InsightsGetReleaseActivityResult>;
}

export interface ApiKeyModel {
  create(row: ApiKeyRow): Promise<"created" | "existing">;
  findByHash(hash: string): Promise<ApiKeyRow | null>;
  list(): Promise<readonly ApiKeyRow[]>;
  revoke(input: {
    readonly id: string;
    readonly revokedAtMs: number;
  }): Promise<ApiKeyRow | null>;
}

export interface ChannelInsertInput {
  readonly row: ChannelRow;
  readonly onConflict: "returnExisting";
}

export interface ChannelInsertResult {
  readonly row: ChannelRow;
  readonly inserted: boolean;
}

export interface ChannelDeleteInput {
  readonly id: string;
}

export type ChannelDeleteResult =
  | { readonly deleted: true }
  | {
      readonly deleted: false;
      readonly reason: "not_found" | "not_empty";
    };

export interface ChannelModel {
  insert(input: ChannelInsertInput): Promise<ChannelInsertResult>;
  list(input: {}): Promise<{ readonly channels: readonly ChannelRow[] }>;
  delete(input: ChannelDeleteInput): Promise<ChannelDeleteResult>;
}

export type DatabaseChange =
  | {
      readonly model: "bundles";
      readonly operation: "insert";
      readonly row: BundleRow;
    }
  | {
      readonly model: "bundles";
      readonly operation: "update";
      readonly where: { readonly id: string };
      readonly update: BundleRowUpdate;
    }
  | {
      readonly model: "bundles";
      readonly operation: "delete";
      readonly where: { readonly id: string };
    }
  | {
      readonly model: "bundlePatches";
      readonly operation: "insert";
      readonly row: BundlePatchRow;
    }
  | {
      readonly model: "bundlePatches";
      readonly operation: "delete";
      readonly where: { readonly bundleId: string };
    }
  | {
      readonly model: "releases";
      readonly operation: "insert";
      readonly row: ReleaseRow;
    }
  | {
      readonly model: "releases";
      readonly operation: "update";
      readonly where: { readonly id: string };
      readonly update: ReleaseRowUpdate;
    }
  | {
      readonly model: "releases";
      readonly operation: "delete";
      readonly where: { readonly id: string };
    }
  | {
      readonly model: "releaseCatalogs";
      readonly operation: "put";
      readonly row: ReleaseCatalogRow;
    }
  | {
      readonly model: "channels";
      readonly operation: "insert";
      readonly row: ChannelRow;
      readonly onConflict: "ignore";
    }
  | {
      readonly model: "channels";
      readonly operation: "delete";
      readonly where: { readonly id: string };
    }
  | {
      readonly model: "apiKeys";
      readonly operation: "insert";
      readonly row: ApiKeyRow;
      readonly onConflict: "ignore";
    }
  | {
      readonly model: "apiKeys";
      readonly operation: "update";
      readonly where: { readonly id: string };
      readonly update: { readonly revokedAtMs: number };
    };

export type DatabaseCommitExpectation =
  | {
      readonly model: "releases";
      readonly id: string;
      readonly revision: number | null;
    }
  | {
      readonly model: "releaseCatalogs";
      readonly scopeKey: string;
      readonly generation: number | null;
    };

export interface DatabaseCommit {
  readonly changes: readonly DatabaseChange[];
  readonly expectations?: readonly DatabaseCommitExpectation[];
}

type BundleRepositoryBundleChange = Extract<
  DatabaseChange,
  { readonly model: "bundles" | "bundlePatches" }
>;

type BundleRepositoryChannelChange = Extract<
  DatabaseChange,
  { readonly model: "channels" }
>;

export type BundleRepositoryChange =
  | BundleRepositoryBundleChange
  | BundleRepositoryChannelChange;

/**
 * The atomic envelopes supported by a bundle-management repository.
 *
 * Bundle and patch changes form one aggregate commit. Channel lifecycle is a
 * separate single-change commit because the standalone HTTP boundary cannot
 * atomically combine a Channel write with a bundle aggregate write.
 */
export type BundleRepositoryCommit =
  | { readonly changes: readonly BundleRepositoryBundleChange[] }
  | { readonly changes: readonly [BundleRepositoryChannelChange] };

export type DatabaseCommitResult =
  | { readonly committed: true }
  | {
      readonly committed: false;
      readonly conflict:
        | {
            readonly changeIndex: number;
            readonly reason: "not_found" | "referenced";
          }
        | {
            readonly changeIndex: -1;
            readonly reason: "version_conflict";
            readonly model: "releases" | "releaseCatalogs";
            readonly key: string;
            readonly expectedVersion: number | null;
            readonly actualVersion: number | null;
          };
    };

export interface DatabaseModels {
  readonly bundles: BundleModel;
  readonly bundlePatches: BundlePatchModel;
  readonly releases: ReleaseModel;
  readonly releaseCatalogs: ReleaseCatalogModel;
  readonly channels: ChannelModel;
  readonly insights: InsightsModel;
  readonly apiKeys: ApiKeyModel;
}

export interface BundleRepository {
  readonly name: string;
  readonly models: Pick<
    DatabaseModels,
    "bundles" | "bundlePatches" | "channels" | "releaseCatalogs" | "releases"
  >;
  commit(input: DatabaseCommit): Promise<DatabaseCommitResult>;
  dispose?: () => Promise<void>;
}

export interface DatabasePlugin {
  readonly name: string;
  readonly models: DatabaseModels;
  commit(input: DatabaseCommit): Promise<DatabaseCommitResult>;
  dispose?: () => Promise<void>;
}
