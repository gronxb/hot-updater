import type {
  DatabaseModel,
  DatabaseOrderBy,
  DatabaseSortBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";

export type PrismaQuery = Readonly<Record<string, unknown>>;
type AnyDatabaseWhere = {
  readonly [TModel in DatabaseModel]: DatabaseWhere<TModel>;
}[DatabaseModel];
type AnyDatabaseSortBy = {
  readonly [TModel in DatabaseModel]: DatabaseSortBy<TModel>;
}[DatabaseModel];
type AnyDatabaseOrderBy = {
  readonly [TModel in DatabaseModel]: DatabaseOrderBy<TModel>;
}[DatabaseModel];

const predicate = (where: AnyDatabaseWhere): PrismaQuery => {
  switch (where.operator) {
    case undefined:
    case "eq":
      return { [where.field]: where.value };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { [where.field]: { [where.operator]: where.value } };
    case "in":
      return { [where.field]: { in: where.value } };
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
    result = { AND: [result, predicate(item)] };
  }
  return result;
};

export const createPrismaOrderBy = (
  orderBy: AnyDatabaseOrderBy | readonly AnyDatabaseSortBy[] | undefined,
): PrismaQuery | PrismaQuery[] | undefined => {
  if (orderBy === undefined) return undefined;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return clauses.map((clause) => ({ [clause.field]: clause.direction }));
};
