import type { DatabaseModel, DatabaseWhere } from "@hot-updater/plugin-core";
import {
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import type { ORMSQLProvider } from "../db/types";
import { escapeGlobPattern, escapeLikePattern } from "./databaseAdapterUtils";
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

const stringPredicate = (
  provider: ORMSQLProvider,
  field: SQLWrapper,
  operator: "contains" | "ends_with" | "starts_with",
  value: string,
  insensitive: boolean,
): SQL => {
  if (provider === "sqlite" && !insensitive) {
    const literal = escapeGlobPattern(value);
    const pattern =
      operator === "contains"
        ? `*${literal}*`
        : operator === "starts_with"
          ? `${literal}*`
          : `*${literal}`;
    return sql`${field} glob ${pattern}`;
  }
  const literal = escapeLikePattern(value);
  const pattern =
    operator === "contains"
      ? `%${literal}%`
      : operator === "starts_with"
        ? `${literal}%`
        : `%${literal}`;
  if (insensitive) {
    return sql`lower(${field}) like lower(${pattern}) escape '\\'`;
  }
  if (provider === "mysql") {
    return sql`binary ${field} like binary ${pattern} escape '\\'`;
  }
  return sql`${field} like ${pattern} escape '\\'`;
};

const predicate = <TModel extends DatabaseModel>(
  provider: ORMSQLProvider,
  table: DrizzleTable,
  condition: DatabaseWhere<TModel>,
): SQL => {
  const field = column(table, condition.field);
  const operator = condition.operator ?? "eq";
  switch (operator) {
    case "eq":
    case "ne": {
      if (condition.value === null) {
        return operator === "eq" ? isNull(field) : isNotNull(field);
      }
      const insensitive =
        "mode" in condition && condition.mode === "insensitive";
      if (insensitive) {
        return operator === "eq"
          ? sql`lower(${field}) = lower(${condition.value})`
          : sql`lower(${field}) <> lower(${condition.value})`;
      }
      return operator === "eq"
        ? eq(field, condition.value)
        : ne(field, condition.value);
    }
    case "gt":
      return gt(field, condition.value);
    case "gte":
      return gte(field, condition.value);
    case "lt":
      return lt(field, condition.value);
    case "lte":
      return lte(field, condition.value);
    case "in":
    case "not_in": {
      if (!Array.isArray(condition.value)) {
        throw new InvalidDatabasePredicateError();
      }
      if (operator === "in") {
        return condition.value.length === 0
          ? sql`false`
          : inArray(field, condition.value);
      }
      return condition.value.length === 0
        ? sql`true`
        : notInArray(field, condition.value);
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      if (typeof condition.value !== "string") {
        throw new InvalidDatabasePredicateError();
      }
      return stringPredicate(
        provider,
        field,
        operator,
        condition.value,
        "mode" in condition && condition.mode === "insensitive",
      );
    }
  }
};

export const buildDrizzleWhere = <TModel extends DatabaseModel>(
  provider: ORMSQLProvider,
  table: DrizzleTable,
  where: readonly DatabaseWhere<TModel>[],
): SQL | undefined => {
  const [first, ...rest] = where;
  if (first === undefined) return undefined;
  let expression = predicate(provider, table, first);
  for (const condition of rest) {
    const next = predicate(provider, table, condition);
    expression =
      condition.connector === "OR"
        ? sql`(${expression} or ${next})`
        : sql`(${expression} and ${next})`;
  }
  return expression;
};
