import type { BundleChangeSetV2, BundleRepositoryV2 } from "./bundles";
import type { AssertedDatabaseScope, MaybePromise } from "./common";
import type { DatabaseConnectorManifestV2 } from "./manifest";
import type { CommitReceiptV2 } from "./receipts";

export interface DatabaseSessionV2 {
  readonly bundles: BundleRepositoryV2;
  applyChangeSet(changeSet: BundleChangeSetV2): Promise<CommitReceiptV2>;
  close(): Promise<void>;
}

export interface DatabaseConnectionV2<TContext> {
  openSession(
    scope: AssertedDatabaseScope<TContext>,
  ): Promise<DatabaseSessionV2>;
  close(): Promise<void>;
}

export interface DatabaseConnectorV2<TContext = unknown> {
  readonly manifest: DatabaseConnectorManifestV2;
  connect(): MaybePromise<DatabaseConnectionV2<TContext>>;
}
