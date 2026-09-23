import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import {
  isBooleanField,
  isNumberField,
  isRecord,
  isStringField,
  modelValidators,
  sortableFields,
  type OrderByClause,
  validateField,
  validateFields,
} from "./databasePluginCrudValidationFields";
import type {
  DatabaseBundleQueryOptions,
  DatabaseModel,
} from "./types/internal";

export const validateSelect = (model: DatabaseModel, select: unknown): void => {
  if (select === undefined) return;
  if (!Array.isArray(select) || select.length === 0) {
    throw new DatabasePluginInputError("empty-select");
  }
  if (!select.every((field) => typeof field === "string")) {
    throw new DatabasePluginInputError("invalid-query");
  }
  validateFields(model, select);
};

const whereKeys = new Set(["field", "operator", "value"]);

const validateWhereValue = (
  model: DatabaseModel,
  condition: Readonly<Record<string, unknown>>,
): void => {
  const field = condition.field;
  if (typeof field !== "string")
    throw new DatabasePluginInputError("invalid-query");
  validateField(model, field);
  const operator = condition.operator ?? "eq";
  const value = condition.value;
  switch (operator) {
    case "eq":
      if (
        !(
          isStringField(field) ||
          isNumberField(field) ||
          isBooleanField(field)
        ) ||
        !modelValidators[model][field]?.(value)
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      return;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (
        !(isStringField(field) || isNumberField(field)) ||
        value === null ||
        !modelValidators[model][field]?.(value)
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      return;
    case "in":
      if (!Array.isArray(value))
        throw new DatabasePluginInputError("invalid-query");
      if (
        !(isStringField(field) || isNumberField(field) || isBooleanField(field))
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      if (!value.every((item) => modelValidators[model][field]?.(item))) {
        throw new DatabasePluginInputError("invalid-query");
      }
      return;
    default:
      throw new DatabasePluginInputError("invalid-query");
  }
};

export const validateWhere = (model: DatabaseModel, where: unknown): void => {
  if (where === undefined) return;
  if (!Array.isArray(where))
    throw new DatabasePluginInputError("invalid-query");
  for (const item of where) {
    // Conditions are always joined with AND; unknown keys such as a
    // connector or a comparison mode are rejected instead of ignored.
    if (!isRecord(item) || Object.keys(item).some((key) => !whereKeys.has(key)))
      throw new DatabasePluginInputError("invalid-query");
    validateWhereValue(model, item);
  }
};

export const validateDistinctFields = (
  model: DatabaseModel,
  fields: unknown,
): readonly string[] | undefined => {
  if (fields === undefined) return undefined;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new DatabasePluginInputError("invalid-distinct");
  }
  if (!fields.every((field) => typeof field === "string")) {
    throw new DatabasePluginInputError("invalid-distinct");
  }
  validateFields(model, fields);
  return fields;
};

export const validateOrderBy = (
  model: DatabaseModel,
  orderBy: unknown,
): readonly OrderByClause[] | undefined => {
  if (orderBy === undefined) return undefined;
  if (!Array.isArray(orderBy) || orderBy.length === 0) {
    throw new DatabasePluginInputError("invalid-query");
  }
  const fields = new Set<string>();
  return orderBy.map((clause) => {
    if (!isRecord(clause) || typeof clause.field !== "string") {
      throw new DatabasePluginInputError("invalid-query");
    }
    validateField(model, clause.field);
    if (!sortableFields[model].has(clause.field)) {
      throw new DatabasePluginInputError("invalid-query");
    }
    if (clause.direction !== "asc" && clause.direction !== "desc") {
      throw new DatabasePluginInputError("invalid-query");
    }
    if (
      clause.nulls !== undefined &&
      clause.nulls !== "first" &&
      clause.nulls !== "last"
    ) {
      throw new DatabasePluginInputError("invalid-query");
    }
    if (fields.has(clause.field)) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    fields.add(clause.field);
    return clause as OrderByClause;
  });
};

export const validateNoDistinctOn = (input: object): void => {
  if (Object.hasOwn(input, "distinctOn")) {
    throw new DatabasePluginInputError("invalid-distinct");
  }
};

export const validatePagination = (
  limit: number | undefined,
  offset: number | undefined,
): void => {
  const effectiveLimit = limit ?? 100;
  const effectiveOffset = offset ?? 0;
  if (
    (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) ||
    (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) ||
    !Number.isSafeInteger(effectiveOffset + effectiveLimit)
  ) {
    throw new DatabasePluginInputError("invalid-pagination");
  }
};

export const validateBundlePagination = (
  options: DatabaseBundleQueryOptions,
): void => {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit <= 0 ||
    (options.page !== undefined &&
      (!Number.isSafeInteger(options.page) || options.page <= 0)) ||
    (options.page !== undefined && options.cursor !== undefined)
  ) {
    throw new DatabasePluginInputError("invalid-pagination");
  }
  const cursor = options.cursor;
  if (cursor === undefined) return;
  if (!isRecord(cursor)) {
    throw new DatabasePluginInputError("invalid-pagination");
  }
  const hasAfter = Object.hasOwn(cursor, "after");
  const hasBefore = Object.hasOwn(cursor, "before");
  if (hasAfter === hasBefore) {
    throw new DatabasePluginInputError("invalid-pagination");
  }
  const value = hasAfter ? cursor.after : cursor.before;
  if (typeof value !== "string" || value.length === 0) {
    throw new DatabasePluginInputError("invalid-pagination");
  }
};
