import type {
  DatabaseModel,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";
import {
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import type { DrizzleTable } from "./drizzleLazyDB";

class InvalidDatabasePredicateError extends Error {
  readonly name = "InvalidDatabasePredicateError";
}

class MissingDrizzleColumnError extends Error {
  readonly name = "MissingDrizzleColumnError";

  constructor(readonly column: string) {
    super(`Drizzle schema is missing column "${column}".`);
  }
}

const isSQLWrapper = (value: unknown): value is SQLWrapper =>
  typeof value === "object" &&
  value !== null &&
  "getSQL" in value &&
  typeof value.getSQL === "function";

const column = (table: DrizzleTable, field: string): SQLWrapper => {
  const value = table[field];
  if (!isSQLWrapper(value)) {
    throw new MissingDrizzleColumnError(field);
  }
  return value;
};

const predicate = <TModel extends DatabaseModel>(
  table: DrizzleTable,
  condition: DatabaseWhere<TModel>,
): SQL => {
  const field = column(table, condition.field);
  const operator = condition.operator ?? "eq";
  switch (operator) {
    case "eq":
      return condition.value === null
        ? isNull(field)
        : eq(field, condition.value);
    case "gt":
      return gt(field, condition.value);
    case "gte":
      return gte(field, condition.value);
    case "lt":
      return lt(field, condition.value);
    case "lte":
      return lte(field, condition.value);
    case "in": {
      if (!Array.isArray(condition.value)) {
        throw new InvalidDatabasePredicateError();
      }
      return condition.value.length === 0
        ? sql`false`
        : inArray(field, condition.value);
    }
  }
};

export const buildDrizzleWhere = <TModel extends DatabaseModel>(
  table: DrizzleTable,
  where: readonly DatabaseWhere<TModel>[] | undefined,
): SQL | undefined => {
  const items = Array.isArray(where) ? where : [];
  const [first, ...rest] = items;
  if (first === undefined) return undefined;
  let expression = predicate<TModel>(table, first);
  for (const condition of rest) {
    expression = sql`(${expression} and ${predicate<TModel>(table, condition)})`;
  }
  return expression;
};
