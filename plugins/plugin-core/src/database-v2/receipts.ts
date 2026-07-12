export interface ReceiptIdentityV2 {
  readonly changeSetId: string;
  readonly scopeId: string;
  readonly canonicalPayloadHash: string;
}

export type CommitReceiptV2 =
  | (ReceiptIdentityV2 & {
      readonly outcome: "committed" | "replayed";
      readonly revisions: Readonly<Record<string, string>>;
    })
  | (ReceiptIdentityV2 & {
      readonly outcome: "rejected";
      readonly reason: "conflict" | "unsupported";
    })
  | (ReceiptIdentityV2 & {
      readonly outcome: "unknown";
      readonly reason: "transport-unknown";
      readonly sessionState: "poisoned";
      readonly retry: "identical-scope-id-and-payload-only";
    });
