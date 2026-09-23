import type {
  DatabaseModel,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";

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

const predicate = (condition: SupabaseWhere): string => {
  const operator = condition.operator ?? "eq";
  const field = condition.field;
  switch (operator) {
    case "eq": {
      if (condition.value === null) {
        return `${field}.is.null`;
      }
      if (
        typeof condition.value !== "boolean" &&
        typeof condition.value !== "number" &&
        typeof condition.value !== "string"
      ) {
        throw new InvalidSupabasePredicateError();
      }
      return `${field}.eq.${encodeValue(condition.value)}`;
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
    case "in": {
      if (!Array.isArray(condition.value)) {
        throw new InvalidSupabasePredicateError();
      }
      if (condition.value.length === 0) {
        return `and(${field}.is.null,${field}.not.is.null)`;
      }
      const values = condition.value.map(encodeValue).join(",");
      return `${field}.in.(${values})`;
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
    expression = `and(${expression},${predicate(condition)})`;
  }
  return expression;
};
