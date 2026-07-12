import type {
  DatabaseStringComparisonMode,
  DatabaseWhereConnector,
  DatabaseWhereOperator,
} from "@hot-updater/plugin-core";

export type D1Query = {
  readonly sql: string;
  readonly params: readonly string[];
};

type D1Predicate = {
  readonly field: string;
  readonly operator?: DatabaseWhereOperator;
  readonly value: unknown;
  readonly connector?: DatabaseWhereConnector;
  readonly mode?: DatabaseStringComparisonMode;
};

type D1Sort = {
  readonly field: string;
  readonly direction: "asc" | "desc";
};

class InvalidD1PredicateError extends Error {
  readonly name = "InvalidD1PredicateError";
}

const encodeD1Value = (value: unknown): string =>
  JSON.stringify(value) ?? "null";

const bind = (value: unknown): D1Query => ({
  sql: "json_extract(?, '$')",
  params: [encodeD1Value(value)],
});

const escapeLikePattern = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

const stringPredicate = (
  condition: D1Predicate,
  operator: "contains" | "ends_with" | "starts_with",
): D1Query => {
  if (typeof condition.value !== "string") {
    throw new InvalidD1PredicateError();
  }
  const literal = escapeLikePattern(condition.value);
  const pattern =
    operator === "contains"
      ? `%${literal}%`
      : operator === "starts_with"
        ? `${literal}%`
        : `%${literal}`;
  const parameter = bind(pattern);
  const column =
    condition.mode === "insensitive"
      ? `lower(${condition.field})`
      : condition.field;
  const value =
    condition.mode === "insensitive"
      ? `lower(${parameter.sql})`
      : parameter.sql;
  return {
    sql: `${column} LIKE ${value} ESCAPE '\\'`,
    params: parameter.params,
  };
};

const predicate = (condition: D1Predicate): D1Query => {
  const operator = condition.operator ?? "eq";
  switch (operator) {
    case "eq":
    case "ne": {
      if (condition.value === null) {
        return {
          sql: `${condition.field} IS ${operator === "ne" ? "NOT " : ""}NULL`,
          params: [],
        };
      }
      const parameter = bind(condition.value);
      const insensitive =
        "mode" in condition && condition.mode === "insensitive";
      const column = insensitive
        ? `lower(${condition.field})`
        : condition.field;
      const value = insensitive ? `lower(${parameter.sql})` : parameter.sql;
      return {
        sql: `${column} ${operator === "eq" ? "=" : "<>"} ${value}`,
        params: parameter.params,
      };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const sqlOperator = {
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      }[operator];
      const parameter = bind(condition.value);
      return {
        sql: `${condition.field} ${sqlOperator} ${parameter.sql}`,
        params: parameter.params,
      };
    }
    case "in":
    case "not_in": {
      if (!Array.isArray(condition.value)) {
        throw new InvalidD1PredicateError();
      }
      if (condition.value.length === 0) {
        return { sql: operator === "not_in" ? "1 = 1" : "1 = 0", params: [] };
      }
      return {
        sql: `${condition.field} ${operator === "not_in" ? "NOT " : ""}IN (SELECT value FROM json_each(?))`,
        params: [encodeD1Value(condition.value)],
      };
    }
    case "contains":
    case "starts_with":
    case "ends_with":
      return stringPredicate(condition, operator);
  }
};

export const buildD1Where = (
  where: readonly D1Predicate[] | undefined,
): D1Query => {
  const [first, ...rest] = where ?? [];
  if (first === undefined) return { sql: "", params: [] };
  const initial = predicate(first);
  let sql = initial.sql;
  const params = [...initial.params];
  for (const condition of rest) {
    const next = predicate(condition);
    sql = `(${sql} ${condition.connector === "OR" ? "OR" : "AND"} ${next.sql})`;
    params.push(...next.params);
  }
  return { sql: ` WHERE ${sql}`, params };
};

export const buildD1Order = (sortBy: D1Sort | undefined): string =>
  sortBy === undefined
    ? ""
    : ` ORDER BY ${sortBy.field} ${sortBy.direction.toUpperCase()}`;

export const d1Placeholders = (count: number): string =>
  Array.from({ length: count }, () => "json_extract(?, '$')").join(", ");

export const encodeD1Values = (values: readonly unknown[]): readonly string[] =>
  values.map(encodeD1Value);
