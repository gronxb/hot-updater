import { compareInsightsText } from "@hot-updater/plugin-core";
import type {
  DatabaseModel,
  DatabaseOrderBy,
  DatabaseRow,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return compareInsightsText(String(left), String(right));
};

const matchesCondition = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  condition: DatabaseWhere<TModel>,
): boolean => {
  const actual = Reflect.get(row, condition.field);
  const expected = condition.value;
  switch (condition.operator ?? "eq") {
    case "eq":
      return actual === expected;
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
  }
};

export const matchesMockDatabaseWhere = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  where: readonly DatabaseWhere<TModel>[] | undefined,
): boolean =>
  (where ?? []).every((condition) => matchesCondition(row, condition));

export const queryMockDatabaseRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  input: {
    readonly where?: readonly DatabaseWhere<TModel>[];
    readonly orderBy?: DatabaseOrderBy<TModel>;
    readonly offset: number;
    readonly limit: number;
  },
): DatabaseRow<TModel>[] => {
  const filtered = rows.filter((row) =>
    matchesMockDatabaseWhere(row, input.where),
  );
  const orderBy = input.orderBy;
  if (orderBy) {
    filtered.sort((left, right) => {
      for (const clause of orderBy) {
        const leftValue = Reflect.get(left, clause.field);
        const rightValue = Reflect.get(right, clause.field);
        if (leftValue == null || rightValue == null) {
          if (leftValue == null && rightValue == null) continue;
          const nulls =
            clause.nulls ?? (clause.direction === "asc" ? "last" : "first");
          const direction = leftValue == null ? -1 : 1;
          return nulls === "first" ? direction : -direction;
        }
        const direction = compare(leftValue, rightValue);
        if (direction !== 0) {
          return clause.direction === "asc" ? direction : -direction;
        }
      }
      return 0;
    });
  }
  return filtered.slice(input.offset, input.offset + input.limit);
};
