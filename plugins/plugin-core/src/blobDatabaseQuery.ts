import type {
  DatabaseDistinctOn,
  DatabaseModel,
  DatabaseOrderBy,
  DatabaseRow,
  DatabaseWhere,
} from "./types";

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (left === null || left === undefined) {
    return right === null || right === undefined ? 0 : -1;
  }
  if (right === null || right === undefined) {
    return 1;
  }
  return String(left).localeCompare(String(right));
};

const stringComparison = (
  actual: unknown,
  expected: string,
  mode: unknown,
  predicate: (value: string, query: string) => boolean,
): boolean => {
  if (typeof actual !== "string") return false;
  return mode === "insensitive"
    ? predicate(actual.toLocaleLowerCase(), expected.toLocaleLowerCase())
    : predicate(actual, expected);
};

const matchesCondition = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  condition: DatabaseWhere<TModel>,
): boolean => {
  const actual = Reflect.get(row, condition.field);
  const expected = Reflect.get(condition, "value");
  const operator = Reflect.get(condition, "operator") ?? "eq";
  switch (operator) {
    case "eq":
      if (typeof expected === "string") {
        return stringComparison(
          actual,
          expected,
          Reflect.get(condition, "mode"),
          (value, query) => value === query,
        );
      }
      return actual === expected;
    case "ne": {
      if (actual === null || actual === undefined) return false;
      if (typeof expected === "string") {
        return !stringComparison(
          actual,
          expected,
          Reflect.get(condition, "mode"),
          (value, query) => value === query,
        );
      }
      return actual !== expected;
    }
    case "gt":
      if (actual === null || actual === undefined) return false;
      return compare(actual, expected) > 0;
    case "gte":
      if (actual === null || actual === undefined) return false;
      return compare(actual, expected) >= 0;
    case "lt":
      if (actual === null || actual === undefined) return false;
      return compare(actual, expected) < 0;
    case "lte":
      if (actual === null || actual === undefined) return false;
      return compare(actual, expected) <= 0;
    case "in":
      return (
        Array.isArray(expected) &&
        expected.some((candidate: unknown) => candidate === actual)
      );
    case "not_in":
      return (
        Array.isArray(expected) &&
        (expected.length === 0 ||
          (actual !== null &&
            actual !== undefined &&
            expected.every((candidate: unknown) => candidate !== actual)))
      );
    case "contains":
      return typeof expected === "string"
        ? stringComparison(
            actual,
            expected,
            Reflect.get(condition, "mode"),
            (value, query) => value.includes(query),
          )
        : false;
    case "starts_with":
      return typeof expected === "string"
        ? stringComparison(
            actual,
            expected,
            Reflect.get(condition, "mode"),
            (value, query) => value.startsWith(query),
          )
        : false;
    case "ends_with":
      return typeof expected === "string"
        ? stringComparison(
            actual,
            expected,
            Reflect.get(condition, "mode"),
            (value, query) => value.endsWith(query),
          )
        : false;
    default:
      return false;
  }
};

export const matchesBlobDatabaseWhere = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  where: readonly DatabaseWhere<TModel>[] | undefined,
): boolean => {
  if (!where || where.length === 0) return true;
  let result = matchesCondition(row, where[0]);
  for (const condition of where.slice(1)) {
    const current = matchesCondition(row, condition);
    result =
      condition.connector === "OR" ? result || current : result && current;
  }
  return result;
};

const compareRows = <TModel extends DatabaseModel>(
  left: DatabaseRow<TModel>,
  right: DatabaseRow<TModel>,
  orderBy: DatabaseOrderBy<TModel>,
): number => {
  for (const clause of orderBy) {
    const leftValue = Reflect.get(left, clause.field);
    const rightValue = Reflect.get(right, clause.field);
    if (leftValue == null || rightValue == null) {
      if (leftValue == null && rightValue == null) {
        continue;
      }
      const nulls =
        clause.nulls ?? (clause.direction === "asc" ? "last" : "first");
      const order = leftValue == null ? -1 : 1;
      return nulls === "first" ? order : -order;
    }
    const order = compare(leftValue, rightValue);
    if (order !== 0) {
      return clause.direction === "asc" ? order : -order;
    }
  }
  return 0;
};

const distinctKey = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  distinctOn: DatabaseDistinctOn<TModel>,
): string =>
  JSON.stringify(distinctOn.fields.map((field) => Reflect.get(row, field)));

export const queryBlobDatabaseRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  input: {
    readonly where?: readonly DatabaseWhere<TModel>[];
    readonly orderBy?: DatabaseOrderBy<TModel>;
    readonly distinctOn?: DatabaseDistinctOn<TModel>;
    readonly offset?: number;
    readonly limit?: number;
  },
): DatabaseRow<TModel>[] => {
  const filtered = rows.filter((row) =>
    matchesBlobDatabaseWhere(row, input.where),
  );
  const ordered = input.orderBy
    ? filtered.toSorted((left, right) =>
        compareRows(left, right, input.orderBy!),
      )
    : filtered;
  const distinct = input.distinctOn
    ? (() => {
        const seen = new Set<string>();
        const unique: DatabaseRow<TModel>[] = [];
        for (const row of ordered) {
          const key = distinctKey(row, input.distinctOn);
          if (seen.has(key)) continue;
          seen.add(key);
          unique.push(row);
        }
        return unique;
      })()
    : ordered;
  const offset = input.offset ?? 0;
  return distinct.slice(offset, offset + (input.limit ?? 100));
};
