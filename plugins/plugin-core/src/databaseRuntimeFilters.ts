import { getPatchId } from "./databaseRuntimePatches";
import type {
  BundleEventListQuery,
  BundleListQuery,
  BundlePatchListQuery,
  DatabaseBundleEvent,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
} from "./types";

export const bundleMatches = (
  bundle: DatabaseBundleRecord,
  query: BundleListQuery,
): boolean => {
  const where = query.where;
  if (!where) {
    return true;
  }
  if (where.channel !== undefined && bundle.channel !== where.channel) {
    return false;
  }
  if (where.platform !== undefined && bundle.platform !== where.platform) {
    return false;
  }
  if (where.enabled !== undefined && bundle.enabled !== where.enabled) {
    return false;
  }
  if (where.targetAppVersion !== undefined) {
    if (bundle.targetAppVersion !== where.targetAppVersion) {
      return false;
    }
  }
  if (
    where.targetAppVersionIn !== undefined &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  ) {
    return false;
  }
  if (
    where.targetAppVersionNotNull === true &&
    bundle.targetAppVersion === null
  ) {
    return false;
  }
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }
  const id = where.id;
  if (!id) {
    return true;
  }
  if (id.eq !== undefined && bundle.id !== id.eq) {
    return false;
  }
  if (id.gt !== undefined && bundle.id.localeCompare(id.gt) <= 0) {
    return false;
  }
  if (id.gte !== undefined && bundle.id.localeCompare(id.gte) < 0) {
    return false;
  }
  if (id.lt !== undefined && bundle.id.localeCompare(id.lt) >= 0) {
    return false;
  }
  if (id.lte !== undefined && bundle.id.localeCompare(id.lte) > 0) {
    return false;
  }
  return !(id.in !== undefined && !id.in.includes(bundle.id));
};

export const patchMatches = (
  patch: DatabaseBundlePatch,
  query: BundlePatchListQuery,
): boolean => patchMatchesWhere(patch, query.where);

export const patchMatchesWhere = (
  patch: DatabaseBundlePatch,
  where: BundlePatchListQuery["where"],
): boolean => {
  if (!where) {
    return true;
  }
  const patchId = getPatchId(patch);
  if (where.id !== undefined && patchId !== where.id) {
    return false;
  }
  if (where.idIn !== undefined && !where.idIn.includes(patchId)) {
    return false;
  }
  if (where.bundleId !== undefined && patch.bundleId !== where.bundleId) {
    return false;
  }
  if (
    where.baseBundleId !== undefined &&
    patch.baseBundleId !== where.baseBundleId
  ) {
    return false;
  }
  if (
    where.bundleIdIn !== undefined &&
    !where.bundleIdIn.includes(patch.bundleId)
  ) {
    return false;
  }
  return !(
    where.baseBundleIdIn !== undefined &&
    !where.baseBundleIdIn.includes(patch.baseBundleId)
  );
};

type BundlePatchOrderBy = NonNullable<BundlePatchListQuery["orderBy"]>;
type BundlePatchStringOrderField = Exclude<
  BundlePatchOrderBy["field"],
  "orderIndex"
>;

export const getPatchStringField = (
  patch: DatabaseBundlePatch,
  field: BundlePatchStringOrderField,
): string => (field === "id" ? getPatchId(patch) : patch[field]);

export const compareBundlePatches = (
  left: DatabaseBundlePatch,
  right: DatabaseBundlePatch,
  orderBy?: BundlePatchListQuery["orderBy"],
): number => {
  const direction = orderBy?.direction ?? "asc";
  const field = orderBy?.field ?? "orderIndex";
  const result =
    field === "orderIndex"
      ? left.orderIndex - right.orderIndex ||
        getPatchId(left).localeCompare(getPatchId(right))
      : getPatchStringField(left, field).localeCompare(
          getPatchStringField(right, field),
        );
  return direction === "asc" ? result : -result;
};

export const eventMatches = (
  event: DatabaseBundleEvent,
  query: BundleEventListQuery,
): boolean => {
  const where = query.where;
  if (!where) {
    return true;
  }
  return (
    (where.kind === undefined || event.kind === where.kind) &&
    (where.installId === undefined || event.installId === where.installId) &&
    (where.activeBundleId === undefined ||
      event.activeBundleId === where.activeBundleId) &&
    (where.previousActiveBundleId === undefined ||
      event.previousActiveBundleId === where.previousActiveBundleId) &&
    (where.crashedBundleId === undefined ||
      event.crashedBundleId === where.crashedBundleId) &&
    (where.platform === undefined || event.platform === where.platform) &&
    (where.channel === undefined || event.channel === where.channel) &&
    (where.appVersion === undefined || event.appVersion === where.appVersion) &&
    (where.fingerprintHash === undefined ||
      event.fingerprintHash === where.fingerprintHash) &&
    (where.cohort === undefined || event.cohort === where.cohort) &&
    (where.userId === undefined || event.userId === where.userId)
  );
};
