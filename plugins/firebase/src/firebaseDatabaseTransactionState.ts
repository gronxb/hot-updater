import type {
  DatabaseBundlePatch,
  DatabaseBundleRecord,
  DatabasePluginDeclaration,
} from "@hot-updater/plugin-core";
import {
  sortPatches,
  toPatch,
  toRow,
  type BundlePatchRow,
} from "@hot-updater/plugin-core/internal";

export type FirebaseTransactionBundle = {
  readonly record: DatabaseBundleRecord;
  readonly patches: readonly DatabaseBundlePatch[];
};

export type FirebaseTransactionAttempt = {
  readonly originalBundles: ReadonlyMap<string, FirebaseTransactionBundle>;
  readonly bundles: Map<string, FirebaseTransactionBundle>;
  readonly touchedBundleIds: Set<string>;
};

export type FirebaseTransactionOperation = (
  attempt: FirebaseTransactionAttempt,
) => void;

export const getTargetAppVersionDocId = (
  bundle: Pick<
    DatabaseBundleRecord,
    "channel" | "platform" | "targetAppVersion"
  >,
): string | null =>
  bundle.targetAppVersion
    ? `${bundle.platform}_${bundle.channel}_${bundle.targetAppVersion}`
    : null;

const findPatch = (
  attempt: FirebaseTransactionAttempt,
  patchId: string,
):
  | {
      readonly bundleId: string;
      readonly patch: DatabaseBundlePatch;
    }
  | undefined => {
  for (const [bundleId, bundle] of attempt.bundles) {
    const patch = bundle.patches.find(
      (candidate) => toRow(candidate).id === patchId,
    );
    if (patch) {
      return { bundleId, patch };
    }
  }
  return undefined;
};

const replacePatchSet = (
  attempt: FirebaseTransactionAttempt,
  bundleId: string,
  patches: readonly DatabaseBundlePatch[],
): void => {
  const current = attempt.bundles.get(bundleId);
  if (!current) {
    throw new Error("targetBundleId not found");
  }
  attempt.bundles.set(bundleId, {
    record: current.record,
    patches: sortPatches(patches),
  });
  attempt.touchedBundleIds.add(bundleId);
};

export const createFirebaseTransactionConnection = (
  attempt: FirebaseTransactionAttempt,
  recordOperation: (operation: FirebaseTransactionOperation) => void,
): DatabasePluginDeclaration => ({
  bundles: {
    getById: ({ bundleId }) => attempt.bundles.get(bundleId)?.record ?? null,
    findRecords: () =>
      Array.from(attempt.bundles.values(), (bundle) => bundle.record),
    insert: ({ bundle }) => {
      recordOperation((nextAttempt) => {
        nextAttempt.bundles.set(bundle.id, {
          record: bundle,
          patches: [],
        });
        nextAttempt.touchedBundleIds.add(bundle.id);
      });
    },
    update: ({ bundleId, patch }) => {
      recordOperation((nextAttempt) => {
        const current = nextAttempt.bundles.get(bundleId);
        if (!current) {
          throw new Error("targetBundleId not found");
        }
        nextAttempt.bundles.set(bundleId, {
          record: { ...current.record, ...patch, id: bundleId },
          patches: current.patches,
        });
        nextAttempt.touchedBundleIds.add(bundleId);
      });
    },
    delete: ({ bundleId }) => {
      recordOperation((nextAttempt) => {
        nextAttempt.bundles.delete(bundleId);
        nextAttempt.touchedBundleIds.add(bundleId);
      });
    },
  },
  patches: {
    storage: "rows",
    findRows: () =>
      Array.from(attempt.bundles.values()).flatMap((bundle) =>
        bundle.patches.map(toRow),
      ),
    getRowById: ({ patchId }) => {
      const match = findPatch(attempt, patchId);
      return match ? toRow(match.patch) : null;
    },
    insertRow: ({ row }) => {
      recordOperation((nextAttempt) => {
        const patch = toPatch(row);
        const current = nextAttempt.bundles.get(patch.bundleId);
        if (!current) {
          throw new Error("targetBundleId not found");
        }
        replacePatchSet(nextAttempt, patch.bundleId, [
          ...current.patches.filter(
            (candidate) => toRow(candidate).id !== row.id,
          ),
          patch,
        ]);
      });
    },
    updateRow: ({ patchId, row }) => {
      recordOperation((nextAttempt) => {
        const match = findPatch(nextAttempt, patchId);
        if (!match) {
          return;
        }
        const current = nextAttempt.bundles.get(match.bundleId);
        if (!current) {
          return;
        }
        const currentRow = toRow(match.patch);
        const nextRow: BundlePatchRow = {
          ...currentRow,
          ...row,
          id: currentRow.id,
          bundle_id: currentRow.bundle_id,
          base_bundle_id: currentRow.base_bundle_id,
        };
        replacePatchSet(
          nextAttempt,
          match.bundleId,
          current.patches.map((candidate) =>
            toRow(candidate).id === patchId ? toPatch(nextRow) : candidate,
          ),
        );
      });
    },
    deleteRow: ({ patchId }) => {
      recordOperation((nextAttempt) => {
        const match = findPatch(nextAttempt, patchId);
        if (!match) {
          return;
        }
        const current = nextAttempt.bundles.get(match.bundleId);
        if (!current) {
          return;
        }
        replacePatchSet(
          nextAttempt,
          match.bundleId,
          current.patches.filter(
            (candidate) => toRow(candidate).id !== patchId,
          ),
        );
      });
    },
  },
});
