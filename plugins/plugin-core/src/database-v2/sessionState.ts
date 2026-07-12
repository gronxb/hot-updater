import type { BundleChangeSetV2 } from "./bundles";

export type DatabaseSessionStateV2 =
  | "open"
  | "committing"
  | "poisoned"
  | "closing"
  | "closed";

export interface PoisonedCommitIdentityV2 {
  readonly changeSetId: string;
  readonly canonicalPayloadHash: string;
}

export interface PreparedCommitV2 {
  readonly changeSet: BundleChangeSetV2;
  readonly recovery: PoisonedCommitIdentityV2 | null;
}
