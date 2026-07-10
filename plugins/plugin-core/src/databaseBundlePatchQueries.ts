import { toPatch, type BundlePatchRow } from "./databaseBundlePatchRows";
import {
  compareBundlePatches,
  patchMatchesWhere,
} from "./databaseRuntimeFilters";
import { materializePatch } from "./databaseRuntimePatches";
import type {
  BundlePatchFindManyQuery,
  BundlePatchListQuery,
  DatabaseBundlePatch,
} from "./types";

const sortMaterializedPatches = (
  patches: readonly DatabaseBundlePatch[],
  orderBy?: BundlePatchListQuery["orderBy"],
): DatabaseBundlePatch[] =>
  [...patches].sort((left, right) =>
    compareBundlePatches(left, right, orderBy),
  );

const listMaterializedPatches = (
  patches: readonly DatabaseBundlePatch[],
  query: BundlePatchFindManyQuery,
): readonly DatabaseBundlePatch[] => {
  return sortMaterializedPatches(
    patches.filter((patch) => patchMatchesWhere(patch, query.where)),
    query.orderBy,
  ).slice(query.window.offset, query.window.offset + query.window.limit);
};

const countMaterializedPatches = (
  patches: readonly DatabaseBundlePatch[],
  where: BundlePatchListQuery["where"],
): number => patches.filter((patch) => patchMatchesWhere(patch, where)).length;

export const list = (
  rows: readonly BundlePatchRow[],
  query: BundlePatchFindManyQuery,
): readonly DatabaseBundlePatch[] =>
  listMaterializedPatches(rows.map(toPatch), query);

export const count = (
  rows: readonly BundlePatchRow[],
  where: BundlePatchListQuery["where"],
): number => countMaterializedPatches(rows.map(toPatch), where);

export const listPatches = (
  patches: readonly DatabaseBundlePatch[],
  query: BundlePatchFindManyQuery,
): readonly DatabaseBundlePatch[] =>
  listMaterializedPatches(patches.map(materializePatch), query);

export const sortPatches = (
  patches: readonly DatabaseBundlePatch[],
  orderBy?: BundlePatchListQuery["orderBy"],
): DatabaseBundlePatch[] =>
  sortMaterializedPatches(patches.map(materializePatch), orderBy);

export const countPatches = (
  patches: readonly DatabaseBundlePatch[],
  where: BundlePatchListQuery["where"],
): number => countMaterializedPatches(patches.map(materializePatch), where);

export const findPatchInSet = (
  patches: readonly DatabaseBundlePatch[],
  patchId: string,
): DatabaseBundlePatch | null =>
  patches.map(materializePatch).find((patch) => patch.id === patchId) ?? null;
