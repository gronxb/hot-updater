import type {
  DatabaseDistinctOn,
  DatabaseOrderBy,
  DatabaseRow,
  DatabaseSortBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core";

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
};

const normalizeStringComparison = (
  actual: unknown,
  expected: string,
  mode: "insensitive" | "sensitive" | undefined,
): readonly [string, string] | null => {
  if (typeof actual !== "string") return null;
  return mode === "insensitive"
    ? [actual.toLocaleLowerCase(), expected.toLocaleLowerCase()]
    : [actual, expected];
};

const matchesCondition = <
  TModel extends "bundle_patches" | "bundles" | "bundle_events",
>(
  row: DatabaseRow<TModel>,
  condition: DatabaseWhere<TModel>,
): boolean => {
  const actual = Reflect.get(row, condition.field);
  const expected = condition.value;
  switch (condition.operator ?? "eq") {
    case "eq": {
      if (typeof expected !== "string") return actual === expected;
      const mode = "mode" in condition ? condition.mode : undefined;
      const comparison = normalizeStringComparison(actual, expected, mode);
      return comparison !== null && comparison[0] === comparison[1];
    }
    case "ne": {
      if (actual === null || actual === undefined) return false;
      if (typeof expected !== "string") return actual !== expected;
      const mode = "mode" in condition ? condition.mode : undefined;
      const comparison = normalizeStringComparison(actual, expected, mode);
      return comparison === null || comparison[0] !== comparison[1];
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
    case "in": {
      if (!Array.isArray(expected)) return false;
      const values: readonly unknown[] = expected;
      return values.some((candidate) => candidate === actual);
    }
    case "not_in": {
      if (!Array.isArray(expected)) return false;
      const values: readonly unknown[] = expected;
      return (
        values.length === 0 ||
        (actual !== null &&
          actual !== undefined &&
          values.every((candidate) => candidate !== actual))
      );
    }
    case "contains": {
      if (typeof expected !== "string") return false;
      const mode = "mode" in condition ? condition.mode : undefined;
      const comparison = normalizeStringComparison(actual, expected, mode);
      return comparison?.[0].includes(comparison[1]) ?? false;
    }
    case "starts_with": {
      if (typeof expected !== "string") return false;
      const mode = "mode" in condition ? condition.mode : undefined;
      const comparison = normalizeStringComparison(actual, expected, mode);
      return comparison?.[0].startsWith(comparison[1]) ?? false;
    }
    case "ends_with": {
      if (typeof expected !== "string") return false;
      const mode = "mode" in condition ? condition.mode : undefined;
      const comparison = normalizeStringComparison(actual, expected, mode);
      return comparison?.[0].endsWith(comparison[1]) ?? false;
    }
  }
};

export const matchesFirebaseDatabaseWhere = <
  TModel extends "bundle_patches" | "bundles" | "bundle_events",
>(
  row: DatabaseRow<TModel>,
  where: readonly DatabaseWhere<TModel>[] | undefined,
): boolean => {
  const first = where?.[0];
  if (!first) return true;
  let result = matchesCondition(row, first);
  for (const condition of where.slice(1)) {
    const current = matchesCondition(row, condition);
    result =
      condition.connector === "OR" ? result || current : result && current;
  }
  return result;
};

export const queryFirebaseDatabaseRows = <
  TModel extends "bundle_patches" | "bundles" | "bundle_events",
>(
  rows: readonly DatabaseRow<TModel>[],
  input: {
    readonly model: TModel;
    readonly where?: readonly DatabaseWhere<TModel>[];
    readonly orderBy?: DatabaseOrderBy<TModel>;
    readonly sortBy?: DatabaseSortBy<TModel>;
    readonly distinctOn?: DatabaseDistinctOn<TModel>;
    readonly offset: number;
    readonly limit: number;
  },
): DatabaseRow<TModel>[] => {
  const filtered = rows.filter((row) =>
    matchesFirebaseDatabaseWhere(row, input.where),
  );
  const orderBy = input.orderBy ?? (input.sortBy ? [input.sortBy] : undefined);
  if (orderBy !== undefined) {
    filtered.sort((left, right) => {
      for (const clause of orderBy) {
        const leftValue = Reflect.get(left, clause.field);
        const rightValue = Reflect.get(right, clause.field);
        if (leftValue === rightValue) continue;
        if (
          clause.nulls !== undefined &&
          (leftValue === null || rightValue === null)
        ) {
          const nullComparison = leftValue === null ? -1 : 1;
          return clause.nulls === "first" ? nullComparison : -nullComparison;
        }
        const comparison = compare(leftValue, rightValue);
        if (comparison !== 0) {
          return clause.direction === "asc" ? comparison : -comparison;
        }
      }
      return 0;
    });
  }
  const distinctOn = input.distinctOn;
  if (distinctOn === undefined) {
    return filtered.slice(input.offset, input.offset + input.limit);
  }
  const seen = new Set<string>();
  const distinctRows = filtered.filter((row) => {
    const key = JSON.stringify(
      distinctOn.fields.map((field) => Reflect.get(row, field)),
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return distinctRows.slice(input.offset, input.offset + input.limit);
};
