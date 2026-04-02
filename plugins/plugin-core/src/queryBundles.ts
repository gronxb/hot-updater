import type {
  Bundle,
  DatabaseBundleIdFilter,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
} from "./types";

const compareValue = (
  value: string,
  expected: string | undefined,
  comparator: "eq" | "gt" | "gte" | "lt" | "lte",
): boolean => {
  if (expected === undefined) {
    return true;
  }

  switch (comparator) {
    case "eq":
      return value === expected;
    case "gt":
      return value.localeCompare(expected) > 0;
    case "gte":
      return value.localeCompare(expected) >= 0;
    case "lt":
      return value.localeCompare(expected) < 0;
    case "lte":
      return value.localeCompare(expected) <= 0;
  }
};

export function bundleIdMatchesFilter(
  id: string,
  filter: DatabaseBundleIdFilter | undefined,
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.in && !filter.in.includes(id)) {
    return false;
  }

  return (
    compareValue(id, filter.eq, "eq") &&
    compareValue(id, filter.gt, "gt") &&
    compareValue(id, filter.gte, "gte") &&
    compareValue(id, filter.lt, "lt") &&
    compareValue(id, filter.lte, "lte")
  );
}

export function bundleMatchesQueryWhere(
  bundle: Bundle,
  where: DatabaseBundleQueryWhere | undefined,
): boolean {
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

  if (!bundleIdMatchesFilter(bundle.id, where.id)) {
    return false;
  }

  if (
    where.targetAppVersionNotNull === true &&
    bundle.targetAppVersion === null
  ) {
    return false;
  }

  if (
    where.targetAppVersion !== undefined &&
    bundle.targetAppVersion !== where.targetAppVersion
  ) {
    return false;
  }

  if (
    where.targetAppVersionIn &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  ) {
    return false;
  }

  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }

  return true;
}

export function sortBundles(
  bundles: Bundle[],
  orderBy: DatabaseBundleQueryOrder | undefined,
): Bundle[] {
  const direction = orderBy?.direction ?? "desc";

  if (orderBy && orderBy.field !== "id") {
    return bundles;
  }

  return bundles.slice().sort((a, b) => {
    const result = a.id.localeCompare(b.id);
    return direction === "asc" ? result : -result;
  });
}
