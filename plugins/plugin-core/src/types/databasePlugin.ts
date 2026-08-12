import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";

import type { BundleRowUpdate } from "./databaseOperations";
import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ClientAccessKeyRow,
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

export interface AnalyticsScanCursor {
  readonly receivedAtMs: number;
  readonly id: string;
}

export interface AnalyticsScanInput {
  readonly beforeReceivedAtMs: number;
  readonly after?: AnalyticsScanCursor;
  readonly limit: number;
}

export interface AnalyticsModel {
  append(row: BundleEventRow): Promise<void>;
  scan(input: AnalyticsScanInput): Promise<readonly BundleEventRow[]>;
}

export interface ClientAccessKeyModel {
  create(row: ClientAccessKeyRow): Promise<"created" | "existing">;
  findByHash(hash: string): Promise<ClientAccessKeyRow | null>;
  list(): Promise<readonly ClientAccessKeyRow[]>;
  revoke(input: {
    readonly id: string;
    readonly revokedAtMs: number;
  }): Promise<ClientAccessKeyRow | null>;
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
      readonly model: "analytics";
      readonly operation: "insert";
      readonly row: BundleEventRow;
    }
  | {
      readonly model: "clientAccessKeys";
      readonly operation: "insert";
      readonly row: ClientAccessKeyRow;
      readonly onConflict: "ignore";
    }
  | {
      readonly model: "clientAccessKeys";
      readonly operation: "update";
      readonly where: { readonly id: string };
      readonly update: { readonly revokedAtMs: number };
    };

export interface DatabaseCommit {
  readonly changes: readonly DatabaseChange[];
}

export type BundleRepositoryChange = Extract<
  DatabaseChange,
  { readonly model: "bundles" | "bundlePatches" | "channels" }
>;

export interface BundleRepositoryCommit {
  readonly changes: readonly BundleRepositoryChange[];
}

export type DatabaseCommitResult =
  | { readonly committed: true }
  | {
      readonly committed: false;
      readonly conflict: {
        readonly changeIndex: number;
        readonly reason: "not_found" | "referenced";
      };
    };

export interface DatabaseModels {
  readonly bundles: BundleModel;
  readonly bundlePatches: BundlePatchModel;
  readonly channels: ChannelModel;
  readonly analytics: AnalyticsModel;
  readonly clientAccessKeys: ClientAccessKeyModel;
}

export interface DatabaseQueries {
  readonly getUpdateInfo?: (
    input: GetBundlesArgs,
  ) => Promise<UpdateInfo | null>;
}

export interface BundleRepository {
  readonly name: string;
  readonly models: Pick<
    DatabaseModels,
    "bundles" | "bundlePatches" | "channels"
  >;
  readonly queries: DatabaseQueries;
  commit(input: BundleRepositoryCommit): Promise<DatabaseCommitResult>;
  dispose?: () => Promise<void>;
}

export interface DatabasePlugin {
  readonly name: string;
  readonly models: DatabaseModels;
  readonly queries: DatabaseQueries;
  commit(input: DatabaseCommit): Promise<DatabaseCommitResult>;
  dispose?: () => Promise<void>;
}
