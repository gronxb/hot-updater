import type { DatabaseModel, DatabaseWhere } from "@hot-updater/plugin-core";

type SupabaseWhere = {
  readonly [TModel in DatabaseModel]: DatabaseWhere<TModel>;
}[DatabaseModel];

type SupabaseWhereList = {
  readonly [TModel in DatabaseModel]: readonly DatabaseWhere<TModel>[];
}[DatabaseModel];

class InvalidSupabasePredicateError extends Error {
  readonly name = "InvalidSupabasePredicateError";
}

const encodeValue = (value: boolean | number | string): string => {
  if (typeof value !== "string") {
    return String(value);
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
};

const encodePattern = (value: string): string =>
  encodeValue(value.replaceAll("*", "\\*").replaceAll("%", "\\%"));

const predicate = (condition: SupabaseWhere): string => {
  const operator = condition.operator ?? "eq";
  const field = condition.field;
  switch (operator) {
    case "eq":
    case "ne": {
      if (condition.value === null) {
        return `${field}.${operator === "eq" ? "is" : "not.is"}.null`;
      }
      if (
        typeof condition.value !== "boolean" &&
        typeof condition.value !== "number" &&
        typeof condition.value !== "string"
      ) {
        throw new InvalidSupabasePredicateError();
      }
      const insensitive =
        "mode" in condition && condition.mode === "insensitive";
      if (insensitive) {
        const comparison = encodePattern(condition.value);
        return `${field}.${operator === "eq" ? "ilike" : "not.ilike"}.${comparison}`;
      }
      return `${field}.${operator === "eq" ? "eq" : "neq"}.${encodeValue(condition.value)}`;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (
        typeof condition.value !== "number" &&
        typeof condition.value !== "string"
      ) {
        throw new InvalidSupabasePredicateError();
      }
      return `${field}.${operator}.${encodeValue(condition.value)}`;
    }
    case "in":
    case "not_in": {
      if (!Array.isArray(condition.value)) {
        throw new InvalidSupabasePredicateError();
      }
      if (condition.value.length === 0) {
        return operator === "in"
          ? `and(${field}.is.null,${field}.not.is.null)`
          : `or(${field}.is.null,${field}.not.is.null)`;
      }
      const values = condition.value.map(encodeValue).join(",");
      return `${field}.${operator === "in" ? "in" : "not.in"}.(${values})`;
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      if (typeof condition.value !== "string") {
        throw new InvalidSupabasePredicateError();
      }
      const literal = encodePattern(condition.value);
      const value = literal.slice(1, -1);
      const pattern =
        operator === "contains"
          ? `"*${value}*"`
          : operator === "starts_with"
            ? `"${value}*"`
            : `"*${value}"`;
      const comparison =
        "mode" in condition && condition.mode === "insensitive"
          ? "ilike"
          : "like";
      return `${field}.${comparison}.${pattern}`;
    }
  }
};

export const buildSupabaseFilter = (
  where: SupabaseWhereList | undefined,
): string | undefined => {
  const [first, ...rest] = where ?? [];
  if (first === undefined) {
    return undefined;
  }
  let expression = predicate(first);
  for (const condition of rest) {
    const next = predicate(condition);
    expression =
      condition.connector === "OR"
        ? `or(${expression},${next})`
        : `and(${expression},${next})`;
  }
  return expression;
};
