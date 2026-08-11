import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";

import type { BundleRowUpdate } from "./databaseOperations";
import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ClientAccessKeyRow,
} from "./databaseRows";
import type {
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
} from "./index";

export interface BundleTableQuery {
  readonly where?: DatabaseBundleQueryWhere;
  readonly limit: number;
  readonly offset: number;
  readonly orderBy: DatabaseBundleQueryOrder;
}

export interface BundleTable {
  findById(id: string): Promise<BundleRow | null>;
  findMany(query: BundleTableQuery): Promise<readonly BundleRow[]>;
  count(where?: DatabaseBundleQueryWhere): Promise<number>;
}

export interface BundlePatchTable {
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

export interface AnalyticsTable {
  append(row: BundleEventRow): Promise<void>;
  scan(input: AnalyticsScanInput): Promise<readonly BundleEventRow[]>;
}

export interface ClientAccessKeyTable {
  create(row: ClientAccessKeyRow): Promise<"created" | "existing">;
  findByHash(hash: string): Promise<ClientAccessKeyRow | null>;
  list(): Promise<readonly ClientAccessKeyRow[]>;
  revoke(input: {
    readonly id: string;
    readonly revokedAtMs: number;
  }): Promise<ClientAccessKeyRow | null>;
}

export type DatabaseChange =
  | {
      readonly table: "bundles";
      readonly operation: "insert";
      readonly row: BundleRow;
    }
  | {
      readonly table: "bundles";
      readonly operation: "update";
      readonly id: string;
      readonly update: BundleRowUpdate;
    }
  | {
      readonly table: "bundles";
      readonly operation: "delete";
      readonly id: string;
    }
  | {
      readonly table: "bundle_patches";
      readonly operation: "insert";
      readonly row: BundlePatchRow;
    }
  | {
      readonly table: "bundle_patches";
      readonly operation: "delete";
      readonly bundleId: string;
    };

export interface DatabaseBundleMutation {
  readonly operation: "insert" | "update" | "delete";
  readonly bundleId: string;
  readonly changes: readonly DatabaseChange[];
}

export interface DatabaseCommit {
  readonly mutations: readonly DatabaseBundleMutation[];
}

export interface DatabaseCommitResult {
  readonly applied: boolean;
  readonly missingBundleId?: string;
}

export interface BundleRepositoryCore {
  readonly bundles: BundleTable;
  readonly bundlePatches: BundlePatchTable;
  commit(input: DatabaseCommit): Promise<DatabaseCommitResult>;
  getChannels?: () => Promise<string[]>;
  getUpdateInfo?: (args: GetBundlesArgs) => Promise<UpdateInfo | null>;
  dispose?: () => Promise<void>;
}

export interface BundleRepository extends BundleRepositoryCore {
  readonly name: string;
}

export interface DatabasePluginCore extends BundleRepositoryCore {
  readonly analytics: AnalyticsTable;
  readonly clientAccessKeys: ClientAccessKeyTable;
}

export interface DatabasePlugin extends BundleRepository, DatabasePluginCore {
  readonly name: string;
}
