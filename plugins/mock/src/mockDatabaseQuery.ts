import type { DatabaseRow, DatabaseWhere } from "@hot-updater/plugin-core";

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
  TModel extends "bundle_patches" | "bundles" | "channels",
>(
  row: DatabaseRow<TModel>,
  condition: DatabaseWhere<TModel>,
): boolean => {
  const actual = Reflect.get(row, condition.field);
  const expected = condition.value;
  switch (condition.operator ?? "eq") {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "gt":
      return compare(actual, expected) > 0;
    case "gte":
      return compare(actual, expected) >= 0;
    case "lt":
      return compare(actual, expected) < 0;
    case "lte":
      return compare(actual, expected) <= 0;
    case "in": {
      if (!Array.isArray(expected)) return false;
      const values: readonly unknown[] = expected;
      return values.some((candidate) => candidate === actual);
    }
    case "not_in": {
      if (!Array.isArray(expected)) return false;
      const values: readonly unknown[] = expected;
      return values.every((candidate) => candidate !== actual);
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

export const matchesMockDatabaseWhere = <
  TModel extends "bundle_patches" | "bundles" | "channels",
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

export const queryMockDatabaseRows = <
  TModel extends "bundle_patches" | "bundles" | "channels",
>(
  rows: readonly DatabaseRow<TModel>[],
  input: {
    readonly where?: readonly DatabaseWhere<TModel>[];
    readonly sortBy?: {
      readonly field: keyof DatabaseRow<TModel>;
      readonly direction: "asc" | "desc";
    };
    readonly offset: number;
    readonly limit: number;
  },
): DatabaseRow<TModel>[] => {
  const filtered = rows.filter((row) =>
    matchesMockDatabaseWhere(row, input.where),
  );
  const sortBy = input.sortBy;
  if (sortBy) {
    const direction = sortBy.direction === "asc" ? 1 : -1;
    filtered.sort(
      (left, right) =>
        compare(
          Reflect.get(left, sortBy.field),
          Reflect.get(right, sortBy.field),
        ) * direction,
    );
  }
  return filtered.slice(input.offset, input.offset + input.limit);
};
