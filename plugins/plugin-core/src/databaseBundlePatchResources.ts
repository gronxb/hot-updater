import {
  count,
  countPatches,
  findPatchInSet,
  list,
  listPatches,
  sortPatches,
} from "./databaseBundlePatchQueries";
import {
  toPatch,
  toRow,
  toUpdateRow,
  type BundlePatchRow,
} from "./databaseBundlePatchRows";
import {
  createOneShotReadSnapshot,
  shouldRememberReadSnapshot,
} from "./databaseReadSnapshot";
import { materializePatch } from "./databaseRuntimePatches";
import type {
  BundlePatchListQuery,
  BundlePatchResource,
  DatabaseBundlePatch,
  MaybePromise,
} from "./types";

export interface BundlePatchRowStore {
  readonly findRows: () => MaybePromise<readonly BundlePatchRow[]>;
  readonly getRowById: (params: {
    readonly patchId: string;
  }) => MaybePromise<BundlePatchRow | null>;
  readonly insertRow: (params: {
    readonly row: BundlePatchRow;
  }) => MaybePromise<void>;
  readonly updateRow: (params: {
    readonly patchId: string;
    readonly row: Partial<BundlePatchRow>;
  }) => MaybePromise<void>;
  readonly deleteRow: (params: {
    readonly patchId: string;
  }) => MaybePromise<void>;
}

export interface BundlePatchSetStore {
  readonly findPatches: () => MaybePromise<readonly DatabaseBundlePatch[]>;
  readonly getBundlePatches: (params: {
    readonly bundleId: string;
  }) => MaybePromise<readonly DatabaseBundlePatch[] | null>;
  readonly replaceBundlePatches: (params: {
    readonly bundleId: string;
    readonly patches: readonly DatabaseBundlePatch[];
  }) => MaybePromise<void>;
}

export const buildBundlePatchRowResource = (
  store: BundlePatchRowStore,
): BundlePatchResource => {
  const rowsSnapshot = createOneShotReadSnapshot<BundlePatchRow>();

  const findRows = async () => {
    return rowsSnapshot.take() ?? (await store.findRows());
  };

  return {
    async findMany(query) {
      const rows = await store.findRows();
      const data = list(rows, query);
      if (shouldRememberReadSnapshot(data, query.window)) {
        rowsSnapshot.remember(rows);
      }
      return data;
    },
    async count({ where }) {
      return count(await findRows(), where);
    },
    async getById({ patchId }) {
      const row = await store.getRowById({ patchId });
      return row ? toPatch(row) : null;
    },
    async insert({ patch }) {
      rowsSnapshot.clear();
      await store.insertRow({ row: toRow(patch) });
    },
    async update({ patchId, patch }) {
      const row = toUpdateRow(patch);
      if (Object.keys(row).length === 0) return;
      rowsSnapshot.clear();
      await store.updateRow({ patchId, row });
    },
    async delete({ patchId }) {
      rowsSnapshot.clear();
      await store.deleteRow({ patchId });
    },
  };
};

const scopedBundleIds = (where: BundlePatchListQuery["where"]) => {
  if (where?.bundleId !== undefined) {
    return [where.bundleId];
  }
  return where?.bundleIdIn;
};

export const buildBundlePatchSetResource = (
  store: BundlePatchSetStore,
): BundlePatchResource => {
  const patchesSnapshot = createOneShotReadSnapshot<DatabaseBundlePatch>();

  const findPatches = async (where: BundlePatchListQuery["where"]) => {
    const bundleIds = scopedBundleIds(where);
    if (bundleIds !== undefined) {
      const patchSets = await Promise.all(
        bundleIds.map((bundleId) => store.getBundlePatches({ bundleId })),
      );
      return patchSets.flatMap((patches) => patches ?? []);
    }
    return patchesSnapshot.take() ?? (await store.findPatches());
  };

  return {
    async findMany(query) {
      const patches = await findPatches(query.where);
      const data = listPatches(patches, query);
      if (shouldRememberReadSnapshot(data, query.window)) {
        patchesSnapshot.remember(patches);
      }
      return data;
    },
    async count({ where }) {
      return countPatches(await findPatches(where), where);
    },
    async getById({ patchId }) {
      return findPatchInSet(await store.findPatches(), patchId);
    },
    async insert({ patch }) {
      const nextPatch = materializePatch(patch);
      const currentPatches = await store.getBundlePatches({
        bundleId: nextPatch.bundleId,
      });
      if (!currentPatches) {
        throw new Error("targetBundleId not found");
      }
      const patches = currentPatches
        .map(materializePatch)
        .filter((currentPatch) => currentPatch.id !== nextPatch.id);
      patchesSnapshot.clear();
      await store.replaceBundlePatches({
        bundleId: nextPatch.bundleId,
        patches: sortPatches([...patches, nextPatch]),
      });
    },
    async update({ patchId, patch }) {
      const currentPatch = findPatchInSet(await store.findPatches(), patchId);
      if (!currentPatch) return;
      const currentPatches = await store.getBundlePatches({
        bundleId: currentPatch.bundleId,
      });
      if (!currentPatches) return;
      const nextPatch = materializePatch({
        ...currentPatch,
        ...patch,
        id: patchId,
      });
      patchesSnapshot.clear();
      await store.replaceBundlePatches({
        bundleId: currentPatch.bundleId,
        patches: currentPatches
          .map(materializePatch)
          .map((candidate) =>
            candidate.id === patchId ? nextPatch : candidate,
          ),
      });
    },
    async delete({ patchId }) {
      const currentPatch = findPatchInSet(await store.findPatches(), patchId);
      if (!currentPatch) return;
      const currentPatches = await store.getBundlePatches({
        bundleId: currentPatch.bundleId,
      });
      if (!currentPatches) return;
      patchesSnapshot.clear();
      await store.replaceBundlePatches({
        bundleId: currentPatch.bundleId,
        patches: currentPatches
          .map(materializePatch)
          .filter((patch) => patch.id !== patchId),
      });
    },
  };
};
