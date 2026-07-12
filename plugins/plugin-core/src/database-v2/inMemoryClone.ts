import type { Bundle } from "@hot-updater/core";

import { snapshotCanonicalDatabaseValueV1 } from "./canonicalIdentity";
import type { Versioned } from "./common";
import type { CommitReceiptV2 } from "./receipts";

export const cloneInMemoryBundleV2 = (bundle: Bundle): Bundle =>
  snapshotCanonicalDatabaseValueV1(bundle);

export const cloneInMemoryVersionedBundleV2 = (
  row: Versioned<Bundle>,
): Versioned<Bundle> =>
  Object.freeze({
    value: cloneInMemoryBundleV2(row.value),
    revision: row.revision,
  });

export const cloneInMemoryReceiptV2 = (
  receipt: CommitReceiptV2,
): CommitReceiptV2 => {
  switch (receipt.outcome) {
    case "committed":
    case "replayed":
      return Object.freeze({
        ...receipt,
        revisions: Object.freeze({ ...receipt.revisions }),
      });
    case "rejected":
    case "unknown":
      return Object.freeze({ ...receipt });
  }
};
