import type { Bundle } from "@hot-updater/core";

import type {
  BundleChangeSetV2,
  BundlePageQueryV2,
  BundlePageV2,
} from "./bundles";
import type { AssertedDatabaseScope, Sha256Digest, Versioned } from "./common";
import type { DatabaseConnectionV2 } from "./connector";

export interface TestBackendScopeV2 {
  readonly tenantId: string;
  readonly principalId: string;
  readonly scopeId: string;
}

export interface TestBackendCommitRequestV2 {
  readonly scope: TestBackendScopeV2;
  readonly changeSet: BundleChangeSetV2;
  readonly canonicalPayloadHash: string;
}

export interface TestDatabaseBackendV2 {
  get(scope: TestBackendScopeV2, id: string): Promise<Versioned<Bundle> | null>;
  page(
    scope: TestBackendScopeV2,
    query: BundlePageQueryV2,
  ): Promise<BundlePageV2>;
  channels(scope: TestBackendScopeV2): Promise<readonly string[]>;
  commit(request: TestBackendCommitRequestV2): Promise<unknown>;
}

export type TestDatabaseResourceV2 =
  | { readonly ownership: "borrowed" }
  | {
      readonly ownership: "owned";
      dispose(): Promise<void>;
    };

export interface TestConnectionRuntimeOptionsV2 {
  readonly backend: TestDatabaseBackendV2;
  readonly resource: TestDatabaseResourceV2;
  readonly sha256?: Sha256Digest;
}

export type TestConnectionRuntimeFactoryV2 = <TContext>(
  options: TestConnectionRuntimeOptionsV2,
) => DatabaseConnectionV2<TContext>;

export type MutableScopeFixture = {
  tenantId: string;
  principalId: string;
  context: { tenantId?: string; principalId?: string; marker: string };
};

export type ScopeFixture = AssertedDatabaseScope<
  MutableScopeFixture["context"]
>;
