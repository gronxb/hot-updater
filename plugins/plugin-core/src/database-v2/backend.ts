import type { Bundle } from "@hot-updater/core";

import type {
  BundleChangeSetV2,
  BundlePageQueryV2,
  BundlePageV2,
} from "./bundles";
import type { MaybePromise, Sha256Digest, Versioned } from "./common";

export interface DatabaseBackendScopeV2 {
  readonly tenantId: string;
  readonly principalId: string;
  readonly scopeId: string;
}

export interface DatabaseBackendCommitRequestV2 {
  readonly scope: DatabaseBackendScopeV2;
  readonly changeSet: BundleChangeSetV2;
  readonly canonicalPayloadHash: string;
}

export interface DatabaseBackendV2 {
  get(
    scope: DatabaseBackendScopeV2,
    id: string,
  ): Promise<Versioned<Bundle> | null>;
  page(
    scope: DatabaseBackendScopeV2,
    query: BundlePageQueryV2,
  ): Promise<BundlePageV2>;
  channels(scope: DatabaseBackendScopeV2): Promise<readonly string[]>;
  commit(request: DatabaseBackendCommitRequestV2): Promise<unknown>;
}

export type DatabaseConnectionResourceV2 =
  | { readonly ownership: "borrowed" }
  | {
      readonly ownership: "owned";
      dispose(): MaybePromise<void>;
    };

export interface DatabaseConnectionRuntimeV2Options {
  readonly backend: DatabaseBackendV2;
  readonly resource: DatabaseConnectionResourceV2;
  readonly sha256?: Sha256Digest;
}
