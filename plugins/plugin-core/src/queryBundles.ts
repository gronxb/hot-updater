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

  if (where.platform !== undefined && bundle.platform !== where.platform) {
    return false;
  }

  if (!bundleIdMatchesFilter(bundle.id, where.id)) {
    return false;
  }

  return true;
}

export function sortBundles<TBundle extends { readonly id: string }>(
  bundles: readonly TBundle[],
  orderBy: DatabaseBundleQueryOrder | undefined,
): TBundle[] {
  const direction = orderBy?.direction ?? "desc";

  if (orderBy && orderBy.field !== "id") {
    return [...bundles];
  }

  return bundles.slice().sort((a, b) => {
    const result = a.id.localeCompare(b.id);
    return direction === "asc" ? result : -result;
  });
}
