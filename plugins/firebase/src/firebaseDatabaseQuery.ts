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
  return String(left).localeCompare(String(right));
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

export const matchesFirebaseDatabaseWhere = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  where: readonly DatabaseWhere<TModel>[] | undefined,
): boolean =>
  (where ?? []).every((condition) => matchesCondition(row, condition));

export const queryFirebaseDatabaseRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  input: {
    readonly model: TModel;
    readonly where?: readonly DatabaseWhere<TModel>[];
    readonly orderBy?: DatabaseOrderBy<TModel>;
    readonly offset: number;
    readonly limit: number;
  },
): DatabaseRow<TModel>[] => {
  const filtered = rows.filter((row) =>
    matchesFirebaseDatabaseWhere(row, input.where),
  );
  const orderBy = input.orderBy;
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
  return filtered.slice(input.offset, input.offset + input.limit);
};
