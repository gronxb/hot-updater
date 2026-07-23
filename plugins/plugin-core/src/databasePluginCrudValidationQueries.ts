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
import type { DatabaseModel } from "./types";

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
  const mode = condition.mode;
  if (mode !== undefined && mode !== "sensitive" && mode !== "insensitive") {
    throw new DatabasePluginInputError("invalid-query");
  }
  switch (operator) {
    case "eq":
    case "ne":
      if (
        !(
          isStringField(field) ||
          isNumberField(field) ||
          isBooleanField(field)
        ) ||
        !modelValidators[model][field]?.(value) ||
        (mode !== undefined &&
          (!isStringField(field) || typeof value !== "string"))
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      return;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (
        mode !== undefined ||
        !(isStringField(field) || isNumberField(field)) ||
        value === null ||
        !modelValidators[model][field]?.(value)
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      return;
    case "in":
    case "not_in":
      if (!Array.isArray(value) || mode !== undefined)
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
    case "contains":
    case "starts_with":
    case "ends_with":
      if (
        !isStringField(field) ||
        typeof value !== "string" ||
        !modelValidators[model][field]?.(value)
      ) {
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
    if (!isRecord(item)) throw new DatabasePluginInputError("invalid-query");
    if (
      item.connector !== undefined &&
      item.connector !== "AND" &&
      item.connector !== "OR"
    ) {
      throw new DatabasePluginInputError("invalid-query");
    }
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
    return clause as OrderByClause;
  });
};

export const validateDistinctOn = (
  model: DatabaseModel,
  distinctOn: unknown,
  orderBy: readonly OrderByClause[] | undefined,
): void => {
  if (distinctOn === undefined) return;
  if (!isRecord(distinctOn))
    throw new DatabasePluginInputError("invalid-distinct");
  const fields = validateDistinctFields(model, distinctOn.fields);
  if (fields === undefined || orderBy === undefined) {
    throw new DatabasePluginInputError("invalid-distinct");
  }
  for (const [index, field] of fields.entries()) {
    if (orderBy[index]?.field !== field) {
      throw new DatabasePluginInputError("invalid-distinct");
    }
  }
};

export const validatePagination = (
  limit: number | undefined,
  offset: number | undefined,
): void => {
  if (
    (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) ||
    (offset !== undefined && (!Number.isInteger(offset) || offset < 0))
  ) {
    throw new DatabasePluginInputError("invalid-pagination");
  }
};
