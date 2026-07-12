import type {
  DatabaseModel,
  DatabaseSortBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core";

export type PrismaQuery = Readonly<Record<string, unknown>>;
type AnyDatabaseWhere = {
  readonly [TModel in DatabaseModel]: DatabaseWhere<TModel>;
}[DatabaseModel];
type AnyDatabaseSortBy = {
  readonly [TModel in DatabaseModel]: DatabaseSortBy<TModel>;
}[DatabaseModel];

const stringFilter = (
  operator: "contains" | "ends_with" | "starts_with",
  value: string,
  mode: "insensitive" | "sensitive" | undefined,
): PrismaQuery => {
  const key =
    operator === "starts_with"
      ? "startsWith"
      : operator === "ends_with"
        ? "endsWith"
        : "contains";
  return {
    [key]: value,
    ...(mode === "insensitive" ? { mode } : {}),
  };
};

const predicate = (where: AnyDatabaseWhere): PrismaQuery => {
  switch (where.operator) {
    case undefined:
    case "eq":
      return {
        [where.field]:
          "mode" in where && where.mode === "insensitive"
            ? { equals: where.value, mode: where.mode }
            : where.value,
      };
    case "ne":
      return {
        [where.field]: {
          not: where.value,
          ...("mode" in where && where.mode === "insensitive"
            ? { mode: where.mode }
            : {}),
        },
      };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { [where.field]: { [where.operator]: where.value } };
    case "in":
      return { [where.field]: { in: where.value } };
    case "not_in":
      return { [where.field]: { notIn: where.value } };
    case "contains":
    case "starts_with":
    case "ends_with":
      return {
        [where.field]: stringFilter(where.operator, where.value, where.mode),
      };
  }
};

export const createPrismaWhere = (
  where: readonly AnyDatabaseWhere[] | undefined,
): PrismaQuery => {
  const items = where ?? [];
  const first = items[0];
  if (first === undefined) return {};

  let result = predicate(first);
  for (const item of items.slice(1)) {
    result = {
      [item.connector === "OR" ? "OR" : "AND"]: [result, predicate(item)],
    };
  }
  return result;
};

export const createPrismaOrderBy = (
  sortBy: AnyDatabaseSortBy | undefined,
): PrismaQuery | undefined =>
  sortBy === undefined ? undefined : { [sortBy.field]: sortBy.direction };
