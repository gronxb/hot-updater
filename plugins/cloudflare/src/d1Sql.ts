import type { DatabaseWhereOperator } from "@hot-updater/plugin-core/internal";

export type D1Query = {
  readonly sql: string;
  readonly params: readonly string[];
};

type D1Predicate = {
  readonly field: string;
  readonly operator?: DatabaseWhereOperator;
  readonly value: unknown;
};

type D1Sort = {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly nulls?: "first" | "last";
};

class InvalidD1PredicateError extends Error {
  readonly name = "InvalidD1PredicateError";
}

const encodeD1Value = (value: unknown): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("D1 values must be JSON-serializable.");
  }
  return encoded;
};

const bind = (value: unknown): D1Query => ({
  sql: "json_extract(?, '$')",
  params: [encodeD1Value(value)],
});

const predicate = (condition: D1Predicate): D1Query => {
  const operator = condition.operator ?? "eq";
  switch (operator) {
    case "eq": {
      if (condition.value === null) {
        return { sql: `${condition.field} IS NULL`, params: [] };
      }
      const parameter = bind(condition.value);
      return {
        sql: `${condition.field} = ${parameter.sql}`,
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
    case "in": {
      if (!Array.isArray(condition.value)) {
        throw new InvalidD1PredicateError();
      }
      if (condition.value.length === 0) {
        return { sql: "1 = 0", params: [] };
      }
      return {
        sql: `${condition.field} IN (SELECT value FROM json_each(?))`,
        params: [encodeD1Value(condition.value)],
      };
    }
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
    sql = `(${sql} AND ${next.sql})`;
    params.push(...next.params);
  }
  return { sql: ` WHERE ${sql}`, params };
};

export const buildD1Order = (orderBy: readonly D1Sort[] | undefined): string =>
  orderBy === undefined
    ? ""
    : ` ORDER BY ${orderBy
        .map(
          (clause) =>
            `${clause.field} ${clause.direction.toUpperCase()}${
              clause.nulls ? ` NULLS ${clause.nulls.toUpperCase()}` : ""
            }`,
        )
        .join(", ")}`;

export const d1Placeholders = (count: number): string =>
  Array.from({ length: count }, () => "json_extract(?, '$')").join(", ");

export const encodeD1Values = (values: readonly unknown[]): readonly string[] =>
  values.map(encodeD1Value);
