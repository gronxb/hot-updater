import type {
  DatabaseDistinctOn,
  DatabaseModel,
  DatabaseOrderBy,
  DatabaseRow,
  DatabaseWhere,
} from "@hot-updater/plugin-core";

const compareOrdered = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (left === null || left === undefined) {
    return right === null || right === undefined ? 0 : -1;
  }
  if (right === null || right === undefined) {
    return 1;
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
    case "eq": {
      if (typeof current === "string" && typeof where.value === "string") {
        const mode = "mode" in where ? where.mode : undefined;
        return (
          normalizeString(current, mode) === normalizeString(where.value, mode)
        );
      }
      return Object.is(current, where.value);
    }
    case "ne": {
      if (current === null || current === undefined) return false;
      if (typeof current === "string" && typeof where.value === "string") {
        const mode = "mode" in where ? where.mode : undefined;
        return (
          normalizeString(current, mode) !== normalizeString(where.value, mode)
        );
      }
      return !Object.is(current, where.value);
    }
    case "gt":
      if (current === null || current === undefined) return false;
      return compareOrdered(current, where.value) > 0;
    case "gte":
      if (current === null || current === undefined) return false;
      return compareOrdered(current, where.value) >= 0;
    case "lt":
      if (current === null || current === undefined) return false;
      return compareOrdered(current, where.value) < 0;
    case "lte":
      if (current === null || current === undefined) return false;
      return compareOrdered(current, where.value) <= 0;
    case "in":
      return where.value.some((value) => Object.is(current, value));
    case "not_in":
      return (
        where.value.length === 0 ||
        (current !== null &&
          current !== undefined &&
          where.value.every((value) => !Object.is(current, value)))
      );
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

const compareRows = <TModel extends DatabaseModel>(
  left: DatabaseRow<TModel>,
  right: DatabaseRow<TModel>,
  orderBy: DatabaseOrderBy<TModel>,
): number => {
  for (const clause of orderBy) {
    const leftValue = left[clause.field];
    const rightValue = right[clause.field];
    if (leftValue == null || rightValue == null) {
      if (leftValue == null && rightValue == null) {
        continue;
      }
      const nulls =
        clause.nulls ?? (clause.direction === "asc" ? "last" : "first");
      const order = leftValue == null ? -1 : 1;
      return nulls === "first" ? order : -order;
    }
    const order = compareOrdered(leftValue, rightValue);
    if (order !== 0) {
      return clause.direction === "asc" ? order : -order;
    }
  }
  return 0;
};

const distinctKey = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  distinctOn: DatabaseDistinctOn<TModel>,
): string => JSON.stringify(distinctOn.fields.map((field) => row[field]));

export const queryRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  where: readonly DatabaseWhere<TModel>[] | undefined,
  orderBy: DatabaseOrderBy<TModel> | undefined,
  distinctOn: DatabaseDistinctOn<TModel> | undefined,
  offset: number,
  limit: number,
): DatabaseRow<TModel>[] => {
  const filtered = rows.filter((row) => matchesAll(row, where));
  const ordered = orderBy
    ? filtered.toSorted((left, right) => compareRows(left, right, orderBy))
    : filtered;
  const distinct = distinctOn
    ? (() => {
        const seen = new Set<string>();
        const unique: DatabaseRow<TModel>[] = [];
        for (const row of ordered) {
          const key = distinctKey(row, distinctOn);
          if (seen.has(key)) continue;
          seen.add(key);
          unique.push(row);
        }
        return unique;
      })()
    : ordered;
  return distinct
    .slice(offset, offset + limit)
    .map((row) => structuredClone(row));
};
