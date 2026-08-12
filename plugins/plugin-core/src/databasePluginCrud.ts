import {
  DatabasePluginInputError,
  selectRow,
  validateBundleTargetUpdate,
  validateBundleUpdateData,
  validateClientAccessKeyUpdateData,
  validateCreateData,
  validateDistinctFields,
  validateDistinctOn,
  validateModel,
  validateMutationWhere,
  validateOrderBy,
  validatePagination,
  validateResult,
  validateSelect,
  validateUpdateWhere,
  validateWhere,
} from "./databasePluginCrudValidation";
import type {
  CountDatabaseImplementationInput,
  CreateDatabaseImplementationInput,
  DatabasePluginCrud as DatabasePluginCrudContract,
  DeleteDatabaseImplementationInput,
  FindManyDatabasePluginInput,
  FindOneDatabaseImplementationInput,
  SelectedDatabaseInputRow,
  TransactionDatabasePluginImplementation,
  UpdateDatabaseImplementationInput,
} from "./types/internal";

export {
  DatabasePluginInputError,
  type DatabasePluginInputErrorCode,
} from "./databasePluginCrudValidation";

export type DatabasePluginCrud = DatabasePluginCrudContract;

export const createDatabasePluginCrud = (
  implementation: TransactionDatabasePluginImplementation,
): DatabasePluginCrud => {
  async function create<TInput extends CreateDatabaseImplementationInput>(
    input: TInput,
  ): Promise<SelectedDatabaseInputRow<TInput>> {
    validateModel(input.model);
    validateCreateData(input.model, input.data);
    if (
      input.onConflict !== undefined &&
      !(
        input.onConflict === "ignore" &&
        (input.model === "channels" || input.model === "client_access_keys")
      )
    ) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    validateSelect(input.model, input.select);
    const row = await implementation.create(input);
    validateResult(input.model, row, input.select);
    return selectRow(row, input);
  }

  async function update<TInput extends UpdateDatabaseImplementationInput>(
    input: TInput,
  ): Promise<SelectedDatabaseInputRow<TInput> | null> {
    validateModel(input.model);
    validateWhere(input.model, input.where);
    validateMutationWhere(input.where);
    validateUpdateWhere(input.where);
    if (input.model === "bundles") {
      validateBundleUpdateData(input.update);
    } else if (input.model === "client_access_keys") {
      validateClientAccessKeyUpdateData(input.update);
    } else {
      throw new DatabasePluginInputError("invalid-operation");
    }
    validateSelect(input.model, input.select);
    if (input.model === "bundles") {
      await validateBundleTargetUpdate(implementation, input);
    }
    const row = await implementation.update(input);
    if (row === null) return null;
    validateResult(input.model, row, input.select);
    return selectRow(row, input);
  }

  async function deleteRows(
    input: DeleteDatabaseImplementationInput,
  ): Promise<void> {
    validateModel(input.model);
    if (
      input.model !== "bundles" &&
      input.model !== "bundle_patches" &&
      input.model !== "channels"
    ) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    validateWhere(input.model, input.where);
    validateMutationWhere(input.where);
    await implementation.delete(input);
  }

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
    const explicitOrderBy = input.orderBy;
    const legacySortBy = input.sortBy;
    const normalizedOrderBy =
      explicitOrderBy ?? (legacySortBy ? [legacySortBy] : undefined);
    const validatedOrderBy = validateOrderBy(input.model, normalizedOrderBy);
    validateDistinctOn(input.model, input.distinctOn, validatedOrderBy);
    const normalizedInput = {
      ...input,
      orderBy: normalizedOrderBy,
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

  return {
    create,
    update,
    delete: deleteRows,
    count,
    findOne,
    findMany,
  };
};
