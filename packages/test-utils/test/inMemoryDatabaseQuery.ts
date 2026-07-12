import type {
  DatabaseModel,
  DatabaseRow,
  DatabaseSortBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core";

const compareOrdered = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }
  return 0;
};

const normalizeString = (
  value: string,
  mode: "insensitive" | "sensitive" | undefined,
): string => (mode === "insensitive" ? value.toLocaleLowerCase() : value);

const matchesWhere = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  where: DatabaseWhere<TModel>,
): boolean => {
  const current = row[where.field];
  switch (where.operator) {
    case undefined:
    case "eq":
      return Object.is(current, where.value);
    case "ne":
      return !Object.is(current, where.value);
    case "gt":
      return compareOrdered(current, where.value) > 0;
    case "gte":
      return compareOrdered(current, where.value) >= 0;
    case "lt":
      return compareOrdered(current, where.value) < 0;
    case "lte":
      return compareOrdered(current, where.value) <= 0;
    case "in":
      return where.value.some((value) => Object.is(current, value));
    case "not_in":
      return where.value.every((value) => !Object.is(current, value));
    case "contains":
      return (
        typeof current === "string" &&
        normalizeString(current, where.mode).includes(
          normalizeString(where.value, where.mode),
        )
      );
    case "starts_with":
      return (
        typeof current === "string" &&
        normalizeString(current, where.mode).startsWith(
          normalizeString(where.value, where.mode),
        )
      );
    case "ends_with":
      return (
        typeof current === "string" &&
        normalizeString(current, where.mode).endsWith(
          normalizeString(where.value, where.mode),
        )
      );
  }
};

export const matchesAll = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  filters: readonly DatabaseWhere<TModel>[] | undefined,
): boolean => {
  if (filters === undefined || filters.length === 0) return true;
  let result = matchesWhere(row, filters[0]);
  for (const filter of filters.slice(1)) {
    result =
      filter.connector === "OR"
        ? result || matchesWhere(row, filter)
        : result && matchesWhere(row, filter);
  }
  return result;
};

export const queryRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  where: readonly DatabaseWhere<TModel>[] | undefined,
  sortBy: DatabaseSortBy<TModel> | undefined,
  offset: number,
  limit: number,
): DatabaseRow<TModel>[] => {
  const filtered = rows.filter((row) => matchesAll(row, where));
  const sorted = sortBy
    ? filtered.toSorted((left, right) => {
        const order = compareOrdered(left[sortBy.field], right[sortBy.field]);
        return sortBy.direction === "asc" ? order : -order;
      })
    : filtered;
  return sorted
    .slice(offset, offset + limit)
    .map((row) => structuredClone(row));
};
