export {
  count,
  countPatches,
  list,
  listPatches,
  sortPatches,
} from "./databaseBundlePatchQueries";
export {
  buildBundlePatchSetResource,
  buildBundlePatchRowResource,
  type BundlePatchSetStore,
  type BundlePatchRowStore,
} from "./databaseBundlePatchResources";
export {
  toPatch,
  toRow,
  toUpdateRow,
  type BundlePatchRow,
} from "./databaseBundlePatchRows";
import {
  count,
  countPatches,
  list,
  listPatches,
  sortPatches,
} from "./databaseBundlePatchQueries";
import { toPatch, toRow, toUpdateRow } from "./databaseBundlePatchRows";
import { materializePatch } from "./databaseRuntimePatches";

export const standardBundlePatchTable = {
  toPatch,
  toRow,
  toUpdateRow,
  list,
  count,
  sortPatches,
  listPatches,
  countPatches,
  materializePatch,
};
