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

const bundlePatchResourceOverrides = new WeakMap<
  BundlePatchRowStore,
  BundlePatchResource
>();

export const setBundlePatchResourceOverride = (
  store: BundlePatchRowStore,
  resource: BundlePatchResource,
): BundlePatchRowStore => {
  bundlePatchResourceOverrides.set(store, resource);
  return store;
};

export const buildBundlePatchRowResource = (
  store: BundlePatchRowStore,
): BundlePatchResource => {
  const resourceOverride = bundlePatchResourceOverrides.get(store);
  if (resourceOverride) {
    return resourceOverride;
  }

  return {
    async findMany(query) {
      const rows = await store.findRows();
      return list(rows, query);
    },
    async count({ where }) {
      return count(await store.findRows(), where);
    },
    async getById({ patchId }) {
      const row = await store.getRowById({ patchId });
      return row ? toPatch(row) : null;
    },
    async insert({ patch }) {
      await store.insertRow({ row: toRow(patch) });
    },
    async update({ patchId, patch }) {
      const row = toUpdateRow(patch);
      if (Object.keys(row).length === 0) return;
      await store.updateRow({ patchId, row });
    },
    async delete({ patchId }) {
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
  const findPatches = async (where: BundlePatchListQuery["where"]) => {
    const bundleIds = scopedBundleIds(where);
    if (bundleIds !== undefined) {
      const patchSets = await Promise.all(
        bundleIds.map((bundleId) => store.getBundlePatches({ bundleId })),
      );
      return patchSets.flatMap((patches) => patches ?? []);
    }
    return store.findPatches();
  };

  return {
    async findMany(query) {
      const patches = await findPatches(query.where);
      return listPatches(patches, query);
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
      await store.replaceBundlePatches({
        bundleId: currentPatch.bundleId,
        patches: currentPatches
          .map(materializePatch)
          .filter((patch) => patch.id !== patchId),
      });
    },
  };
};
