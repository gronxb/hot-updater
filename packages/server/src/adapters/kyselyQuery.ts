import type { DatabaseModel, DatabaseWhere } from "@hot-updater/plugin-core";
import { sql, type RawBuilder } from "kysely";

import type { ORMSQLProvider } from "../db/types";
import { escapeGlobPattern, escapeLikePattern } from "./databasePluginUtils";

class InvalidDatabasePredicateError extends Error {
  readonly name = "InvalidDatabasePredicateError";
}

const stringPredicate = (
  provider: ORMSQLProvider,
  field: string,
  operator: "contains" | "ends_with" | "starts_with",
  value: string,
  insensitive: boolean,
): RawBuilder<boolean> => {
  const column = sql.ref(field);
  if (provider === "sqlite" && !insensitive) {
    const literal = escapeGlobPattern(value);
    const pattern =
      operator === "contains"
        ? `*${literal}*`
        : operator === "starts_with"
          ? `${literal}*`
          : `*${literal}`;
    return sql<boolean>`${column} glob ${pattern}`;
  }

  const literal = escapeLikePattern(value);
  const pattern =
    operator === "contains"
      ? `%${literal}%`
      : operator === "starts_with"
        ? `${literal}%`
        : `%${literal}`;
  if (insensitive) {
    return sql<boolean>`lower(${column}) like lower(${pattern}) escape '\\'`;
  }
  if (provider === "mysql") {
    return sql<boolean>`binary ${column} like binary ${pattern} escape '\\'`;
  }
  return sql<boolean>`${column} like ${pattern} escape '\\'`;
};

const predicate = <TModel extends DatabaseModel>(
  provider: ORMSQLProvider,
  condition: DatabaseWhere<TModel>,
): RawBuilder<boolean> => {
  const column = sql.ref(condition.field);
  const operator = condition.operator ?? "eq";
  switch (operator) {
    case "eq":
    case "ne": {
      if (condition.value === null) {
        return operator === "eq"
          ? sql<boolean>`${column} is null`
          : sql<boolean>`${column} is not null`;
      }
      const insensitive =
        "mode" in condition && condition.mode === "insensitive";
      if (insensitive) {
        return operator === "eq"
          ? sql<boolean>`lower(${column}) = lower(${condition.value})`
          : sql<boolean>`lower(${column}) <> lower(${condition.value})`;
      }
      return operator === "eq"
        ? sql<boolean>`${column} = ${condition.value}`
        : sql<boolean>`${column} <> ${condition.value}`;
    }
    case "gt":
      return sql<boolean>`${column} > ${condition.value}`;
    case "gte":
      return sql<boolean>`${column} >= ${condition.value}`;
    case "lt":
      return sql<boolean>`${column} < ${condition.value}`;
    case "lte":
      return sql<boolean>`${column} <= ${condition.value}`;
    case "in":
    case "not_in": {
      if (!Array.isArray(condition.value)) {
        throw new InvalidDatabasePredicateError();
      }
      if (operator === "in") {
        return condition.value.length === 0
          ? sql<boolean>`false`
          : sql<boolean>`${column} in (${sql.join(condition.value)})`;
      }
      return condition.value.length === 0
        ? sql<boolean>`true`
        : sql<boolean>`${column} not in (${sql.join(condition.value)})`;
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      if (typeof condition.value !== "string") {
        throw new InvalidDatabasePredicateError();
      }
      return stringPredicate(
        provider,
        condition.field,
        operator,
        condition.value,
        "mode" in condition && condition.mode === "insensitive",
      );
    }
  }
};

export const buildKyselyWhere = <TModel extends DatabaseModel>(
  provider: ORMSQLProvider,
  where: readonly DatabaseWhere<TModel>[] | undefined,
): RawBuilder<boolean> | undefined => {
  const [first, ...rest] = where ?? [];
  if (first === undefined) return undefined;
  let expression = predicate(provider, first);
  for (const condition of rest) {
    const next = predicate(provider, condition);
    expression =
      condition.connector === "OR"
        ? sql<boolean>`(${expression} or ${next})`
        : sql<boolean>`(${expression} and ${next})`;
  }
  return expression;
};
