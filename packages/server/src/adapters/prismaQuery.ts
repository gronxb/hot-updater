import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import type {
  DatabaseModel,
  DatabaseOrderBy,
  DatabaseSortBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";

import type { ORMProvider } from "../db/types";

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

const stringFilter = (
  operator: "contains" | "ends_with" | "starts_with",
  value: string,
  mode: "default" | undefined,
): PrismaQuery => {
  const key =
    operator === "starts_with"
      ? "startsWith"
      : operator === "ends_with"
        ? "endsWith"
        : "contains";
  return {
    [key]: value,
    ...(mode ? { mode } : {}),
  };
};

const SQL_PATTERN_METACHARACTERS = /[%_\\]/u;
const MONGODB_PATTERN_METACHARACTERS = /[.*+?^${}()|[\]\\]/u;

const prismaMode = (
  mode: "insensitive" | "sensitive" | undefined,
  provider: ORMProvider,
): "default" | undefined => {
  if (
    mode === "insensitive" ||
    (mode === "sensitive" && provider !== "postgresql")
  ) {
    throw new DatabasePluginInputError("invalid-operation");
  }
  return mode === "sensitive" ? "default" : undefined;
};

const assertLiteralPattern = (value: string, provider: ORMProvider): void => {
  const pattern =
    provider === "mongodb"
      ? MONGODB_PATTERN_METACHARACTERS
      : SQL_PATTERN_METACHARACTERS;
  if (pattern.test(value)) {
    throw new DatabasePluginInputError("invalid-operation");
  }
};

const predicate = (
  where: AnyDatabaseWhere,
  provider: ORMProvider,
): PrismaQuery => {
  const mode = prismaMode("mode" in where ? where.mode : undefined, provider);
  switch (where.operator) {
    case undefined:
    case "eq":
      return {
        [where.field]: mode ? { equals: where.value, mode } : where.value,
      };
    case "ne":
      return {
        [where.field]: {
          not: where.value,
          ...(mode ? { mode } : {}),
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
    case "ends_with": {
      assertLiteralPattern(where.value, provider);
      return {
        [where.field]: stringFilter(where.operator, where.value, mode),
      };
    }
  }
};

export const createPrismaWhere = (
  where: readonly AnyDatabaseWhere[] | undefined,
  provider: ORMProvider,
): PrismaQuery => {
  const items = where ?? [];
  const first = items[0];
  if (first === undefined) return {};

  let result = predicate(first, provider);
  for (const item of items.slice(1)) {
    result = {
      [item.connector === "OR" ? "OR" : "AND"]: [
        result,
        predicate(item, provider),
      ],
    };
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
