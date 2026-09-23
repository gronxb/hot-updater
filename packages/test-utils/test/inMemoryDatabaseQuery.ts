import { compareInsightsText } from "@hot-updater/plugin-core";
import type {
  DatabaseModel,
  DatabaseOrderBy,
  DatabaseRow,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";

const compareOrdered = (
  left: unknown,
  right: unknown,
  byteOrder = false,
): number => {
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
    return byteOrder
      ? compareInsightsText(left, right)
      : left.localeCompare(right);
  }
  return 0;
};

const matchesWhere = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  where: DatabaseWhere<TModel>,
): boolean => {
  const current = row[where.field];
  switch (where.operator) {
    case undefined:
    case "eq":
      return Object.is(current, where.value);
    case "gt":
      if (current === null || current === undefined) return false;
      return (
        compareOrdered(current, where.value, where.field === "install_id") > 0
      );
    case "gte":
      if (current === null || current === undefined) return false;
      return (
        compareOrdered(current, where.value, where.field === "install_id") >= 0
      );
    case "lt":
      if (current === null || current === undefined) return false;
      return (
        compareOrdered(current, where.value, where.field === "install_id") < 0
      );
    case "lte":
      if (current === null || current === undefined) return false;
      return (
        compareOrdered(current, where.value, where.field === "install_id") <= 0
      );
    case "in":
      return where.value.some((value) => Object.is(current, value));
  }
};

export const matchesAll = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  filters: readonly DatabaseWhere<TModel>[] | undefined,
): boolean => (filters ?? []).every((filter) => matchesWhere(row, filter));

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
    const order = compareOrdered(
      leftValue,
      rightValue,
      clause.field === "install_id",
    );
    if (order !== 0) {
      return clause.direction === "asc" ? order : -order;
    }
  }
  return 0;
};

export const queryRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  where: readonly DatabaseWhere<TModel>[] | undefined,
  orderBy: DatabaseOrderBy<TModel> | undefined,
  offset: number,
  limit: number,
): DatabaseRow<TModel>[] => {
  const filtered = rows.filter((row) => matchesAll(row, where));
  const ordered = orderBy
    ? filtered.toSorted((left, right) => compareRows(left, right, orderBy))
    : filtered;
  return ordered
    .slice(offset, offset + limit)
    .map((row) => structuredClone(row));
};
