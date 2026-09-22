import {
  DatabasePluginInputError,
  selectRow,
  validateDistinctFields,
  validateDistinctOn,
  validateModel,
  validateOrderBy,
  validatePagination,
  validateResult,
  validateSelect,
  validateWhere,
} from "./databasePluginCrudValidation";
import type {
  CountDatabaseImplementationInput,
  FindManyDatabasePluginInput,
  FindOneDatabaseImplementationInput,
  SelectedDatabaseInputRow,
  DatabaseReadImplementation,
  DatabasePluginReads,
} from "./types/internal";

export const createDatabasePluginReads = (
  implementation: DatabaseReadImplementation,
): DatabasePluginReads => {
  async function count(
    input: CountDatabaseImplementationInput,
  ): Promise<number> {
    validateModel(input.model);
    validateWhere(input.model, input.where);
    validateDistinctFields(input.model, input.distinct);
    const value = await implementation.count(input);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DatabasePluginInputError("invalid-result");
    }
    return value;
  }

  async function findOne<TInput extends FindOneDatabaseImplementationInput>(
    input: TInput,
  ): Promise<SelectedDatabaseInputRow<TInput> | null> {
    validateModel(input.model);
    validateWhere(input.model, input.where);
    validateSelect(input.model, input.select);
    const row = await implementation.findOne(input);
    if (row === null) return null;
    validateResult(input.model, row, input.select);
    return selectRow(row, input);
  }

  async function findMany<TInput extends FindManyDatabasePluginInput>(
    input: TInput,
  ): Promise<SelectedDatabaseInputRow<TInput>[]> {
    validateModel(input.model);
    validateWhere(input.model, input.where);
    validatePagination(input.limit, input.offset);
    validateSelect(input.model, input.select);
    const validatedOrderBy = validateOrderBy(input.model, input.orderBy);
    validateDistinctOn(input.model, input.distinctOn, validatedOrderBy);
    const normalizedInput = {
      ...input,
      orderBy: input.orderBy,
      limit: input.limit ?? 100,
      offset: input.offset ?? 0,
    };
    const rows = await implementation.findMany(normalizedInput);
    if (!Array.isArray(rows)) {
      throw new DatabasePluginInputError("invalid-result");
    }
    rows.forEach((row) => validateResult(input.model, row, input.select));
    return rows.map((row) => selectRow(row, input));
  }

  return { count, findOne, findMany };
};
