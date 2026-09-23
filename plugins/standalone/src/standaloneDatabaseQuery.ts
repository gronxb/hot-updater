import type {
  DatabaseModel,
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
    case "in":
      return (
        Array.isArray(expected) &&
        expected.some((candidate: unknown) => candidate === actual)
      );
  }
};

export const matchesStandaloneWhere = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  where: readonly DatabaseWhere<TModel>[] | undefined,
): boolean =>
  (where ?? []).every((condition) => matchesCondition(row, condition));

export const queryStandaloneRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  input: {
    readonly where?: readonly DatabaseWhere<TModel>[];
    readonly orderBy?: {
      readonly field: keyof DatabaseRow<TModel>;
      readonly direction: "asc" | "desc";
    };
    readonly offset?: number;
    readonly limit?: number;
  },
): DatabaseRow<TModel>[] => {
  const filtered = rows.filter((row) =>
    matchesStandaloneWhere(row, input.where),
  );
  if (input.orderBy) {
    const direction = input.orderBy.direction === "asc" ? 1 : -1;
    filtered.sort(
      (left, right) =>
        compare(
          Reflect.get(left, input.orderBy?.field ?? "id"),
          Reflect.get(right, input.orderBy?.field ?? "id"),
        ) * direction,
    );
  }
  const offset = input.offset ?? 0;
  return filtered.slice(offset, offset + (input.limit ?? filtered.length));
};
