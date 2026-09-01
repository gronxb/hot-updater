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

export interface InsightsScanCursor {
  readonly receivedAtMs: number;
  readonly id: string;
}

export interface InsightsScanInput {
  readonly beforeReceivedAtMs: number;
  readonly after?: InsightsScanCursor;
  readonly limit: number;
}

export type InsightsEventScope =
  | { readonly kind: "all" }
  | { readonly kind: "installation"; readonly installId: string }
  | { readonly kind: "bundle"; readonly bundleId: string };

export interface InsightsEventPageInput {
  readonly scope: InsightsEventScope;
  /** Inclusive lower boundary. Omitted means the entire history. */
  readonly sinceReceivedAtMs?: number;
  readonly beforeReceivedAtMs: number;
  /** Final response size, including neither lookahead nor merge candidates. */
  readonly limit: number;
  readonly cursor?: string;
}

export interface InsightsEventPage {
  readonly rows: readonly BundleEventRow[];
  /**
   * null proves exhaustion. A continuation may require more bounded work even
   * when this page is short or empty. Callers must not automatically drain it.
   * It resumes after emitted rows, never after unconsumed lookahead candidates.
   */
  readonly nextCursor: string | null;
}

export interface InsightsEventQueries {
  readonly version: 1;
  readonly scopes: readonly InsightsEventScope["kind"][];
  page(input: InsightsEventPageInput): Promise<InsightsEventPage>;
}

export interface InsightsModel {
  append(row: BundleEventRow): Promise<void>;
  scan(input: InsightsScanInput): Promise<readonly BundleEventRow[]>;
  /** Present only for physically paginated, explicitly supported read paths. */
  readonly events?: InsightsEventQueries;
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
