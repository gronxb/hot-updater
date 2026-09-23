import type {
  DatabaseModel,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";
import { sql, type RawBuilder } from "kysely";

class InvalidDatabasePredicateError extends Error {
  readonly name = "InvalidDatabasePredicateError";
}

const predicate = <TModel extends DatabaseModel>(
  condition: DatabaseWhere<TModel>,
): RawBuilder<boolean> => {
  const column = sql.ref(condition.field);
  const operator = condition.operator ?? "eq";
  switch (operator) {
    case "eq":
      return condition.value === null
        ? sql<boolean>`${column} is null`
        : sql<boolean>`${column} = ${condition.value}`;
    case "gt":
      return sql<boolean>`${column} > ${condition.value}`;
    case "gte":
      return sql<boolean>`${column} >= ${condition.value}`;
    case "lt":
      return sql<boolean>`${column} < ${condition.value}`;
    case "lte":
      return sql<boolean>`${column} <= ${condition.value}`;
    case "in": {
      if (!Array.isArray(condition.value)) {
        throw new InvalidDatabasePredicateError();
      }
      return condition.value.length === 0
        ? sql<boolean>`false`
        : sql<boolean>`${column} in (${sql.join(condition.value)})`;
    }
  }
};

export const buildKyselyWhere = <TModel extends DatabaseModel>(
  where: readonly DatabaseWhere<TModel>[] | undefined,
): RawBuilder<boolean> | undefined => {
  const [first, ...rest] = where ?? [];
  if (first === undefined) return undefined;
  let expression = predicate(first);
  for (const condition of rest) {
    expression = sql<boolean>`(${expression} and ${predicate(condition)})`;
  }
  return expression;
};
