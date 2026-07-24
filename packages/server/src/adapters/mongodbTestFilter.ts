import type {
  BundlePatchRow,
  BundleRow,
  DatabaseRow,
} from "@hot-updater/plugin-core";

export type MongoTestRow =
  | BundlePatchRow
  | BundleRow
  | DatabaseRow<"bundle_events">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const readMongoTestField = (row: MongoTestRow, field: string): unknown =>
  Object.entries(row).find(([key]) => key === field)?.[1];

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }
  return 0;
};

const resolveExpression = (row: MongoTestRow, expression: unknown): unknown => {
  if (typeof expression === "string" && expression.startsWith("$")) {
    return readMongoTestField(row, expression.slice(1));
  }
  if (Array.isArray(expression)) {
    return expression.map((item) => resolveExpression(row, item));
  }
  if (!isRecord(expression)) return expression;
  if ("$ifNull" in expression && Array.isArray(expression["$ifNull"])) {
    const [value, fallback] = expression["$ifNull"];
    const resolved = resolveExpression(row, value);
    return resolved === null || resolved === undefined
      ? resolveExpression(row, fallback)
      : resolved;
  }
  if ("$toLower" in expression) {
    const value = resolveExpression(row, expression["$toLower"]);
    return typeof value === "string" ? value.toLocaleLowerCase() : value;
  }
  for (const operator of ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"]) {
    const operands = expression[operator];
    if (!Array.isArray(operands)) continue;
    const [left, right] = operands.map((item) => resolveExpression(row, item));
    switch (operator) {
      case "$eq":
        return Object.is(left, right);
      case "$ne":
        return !Object.is(left, right);
      case "$gt":
        return compare(left, right) > 0;
      case "$gte":
        return compare(left, right) >= 0;
      case "$lt":
        return compare(left, right) < 0;
      case "$lte":
        return compare(left, right) <= 0;
    }
  }
  if ("$in" in expression && Array.isArray(expression["$in"])) {
    const [value, candidates] = expression["$in"].map((item) =>
      resolveExpression(row, item),
    );
    return (
      Array.isArray(candidates) &&
      candidates.some((candidate) => Object.is(candidate, value))
    );
  }
  if ("$not" in expression && Array.isArray(expression["$not"])) {
    return !resolveExpression(row, expression["$not"][0]);
  }
  const regexMatch = expression["$regexMatch"];
  if (isRecord(regexMatch)) {
    const input = resolveExpression(row, regexMatch["input"]);
    const regex = regexMatch["regex"];
    const options = regexMatch["options"];
    return (
      typeof input === "string" &&
      typeof regex === "string" &&
      new RegExp(regex, options === "i" ? "i" : undefined).test(input)
    );
  }
  return expression;
};

const matchesField = (current: unknown, condition: unknown): boolean => {
  if (!isRecord(condition)) return Object.is(current, condition);
  if (typeof condition["$exists"] === "boolean") {
    return condition["$exists"] ? current !== undefined : current === undefined;
  }
  if (Array.isArray(condition["$in"])) {
    return condition["$in"].some((item) => Object.is(item, current));
  }
  if ("$ne" in condition && Object.is(current, condition["$ne"])) {
    return false;
  }
  if ("$gte" in condition && compare(current, condition["$gte"]) < 0) {
    return false;
  }
  if ("$gt" in condition && compare(current, condition["$gt"]) <= 0) {
    return false;
  }
  if ("$lte" in condition && compare(current, condition["$lte"]) > 0) {
    return false;
  }
  if ("$lt" in condition && compare(current, condition["$lt"]) >= 0) {
    return false;
  }
  return true;
};

export const matchesMongoTestFilter = (
  row: MongoTestRow,
  filter: unknown,
): boolean => {
  if (!isRecord(filter)) return true;
  if ("$expr" in filter)
    return Boolean(resolveExpression(row, filter["$expr"]));
  const conjunction = filter["$and"];
  if (Array.isArray(conjunction)) {
    return conjunction.every((item) => matchesMongoTestFilter(row, item));
  }
  const disjunction = filter["$or"];
  if (Array.isArray(disjunction)) {
    return disjunction.some((item) => matchesMongoTestFilter(row, item));
  }
  return Object.entries(filter).every(([field, condition]) =>
    matchesField(readMongoTestField(row, field), condition),
  );
};

export const sortMongoTestRows = (
  rows: MongoTestRow[],
  sort: unknown,
): MongoTestRow[] => {
  if (!isRecord(sort)) return rows;
  const entries = Object.entries(sort);
  if (entries.length === 0) return rows;
  return rows.toSorted((left, right) => {
    for (const [field, direction] of entries) {
      const result = compare(
        readMongoTestField(left, field),
        readMongoTestField(right, field),
      );
      if (result !== 0) {
        return direction === -1 ? -result : result;
      }
    }
    return 0;
  });
};
