import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";

import type { UniversalComponentDataAdapter } from "../universalComponentData";
import type { BundleRowUpdate } from "./databaseOperations";
import type { BundlePatchRow, BundleRow } from "./databaseRows";
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

export interface DatabaseCommit {
  readonly operation: "insert" | "update" | "delete";
  readonly bundleId: string;
  readonly changes: readonly DatabaseChange[];
}

export interface DatabaseCommitResult {
  readonly applied: boolean;
}

export interface DatabasePluginCore {
  readonly bundles: BundleTable;
  readonly bundlePatches: BundlePatchTable;
  readonly componentData?: UniversalComponentDataAdapter;
  commit(input: DatabaseCommit): Promise<DatabaseCommitResult>;
  commitBatch?: (
    inputs: readonly DatabaseCommit[],
  ) => Promise<readonly DatabaseCommitResult[]>;
  getChannels?: () => Promise<string[]>;
  getUpdateInfo?: (args: GetBundlesArgs) => Promise<UpdateInfo | null>;
  onUnmount?: () => Promise<void>;
}

export interface DatabasePlugin extends DatabasePluginCore {
  readonly name: string;
  onDatabaseUpdated?: () => Promise<void>;
}
