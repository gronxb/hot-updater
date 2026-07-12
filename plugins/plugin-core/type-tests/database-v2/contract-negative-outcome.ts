import type { CommitReceiptV2 } from "@hot-updater/plugin-core/database-v2";

const receipt: CommitReceiptV2 = {
  outcome: "committed",
  changeSetId: "change-set-id",
  scopeId: "scope-id",
  canonicalPayloadHash: "payload-hash",
  reason: "conflict",
};

void receipt;
