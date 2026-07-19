import {
  DatabaseAdapterInputError,
  selectRow,
  validateBundleTargetUpdate,
  validateBundleUpdateData,
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
  type OrderByClause,
} from "./databaseAdapterCrudValidation";
import type {
  CountDatabaseInput,
  CreateDatabaseInput,
  DatabaseAdapter,
  DatabaseAdapterImplementation,
  DatabaseModel,
  DatabaseSelect,
  DeleteDatabaseInput,
  FindManyDatabaseInput,
  FindOneDatabaseInput,
  SelectedDatabaseRow,
  UpdateDatabaseInput,
} from "./types";

export {
  DatabaseAdapterInputError,
  type DatabaseAdapterInputErrorCode,
} from "./databaseAdapterCrudValidation";

export type DatabaseAdapterCrud = Pick<
  DatabaseAdapter,
  "count" | "create" | "delete" | "findMany" | "findOne" | "update"
>;

export const createDatabaseAdapterCrud = (
  implementation: DatabaseAdapterImplementation,
): DatabaseAdapterCrud => {
  async function create<
    TModel extends DatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: CreateDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>> {
    validateModel(input.model);
    validateCreateData(input.model, input.data);
    validateSelect(input.model, input.select);
    const row = await implementation.create(input as never);
    validateResult(
      input.model,
      row,
      input.select as readonly string[] | undefined,
    );
    return selectRow<TModel, TSelect>(row, input.select);
  }

  async function update<
    TSelect extends DatabaseSelect<"bundles"> | undefined = undefined,
  >(
    input: UpdateDatabaseInput<"bundles", TSelect>,
  ): Promise<SelectedDatabaseRow<"bundles", TSelect> | null> {
    validateModel(input.model);
    if (input.model !== "bundles") {
      throw new DatabaseAdapterInputError("invalid-operation");
    }
    validateWhere(input.model, input.where);
    validateMutationWhere(input.where);
    validateUpdateWhere(input.where);
    validateBundleUpdateData(input.update);
    validateSelect(input.model, input.select);
    await validateBundleTargetUpdate(implementation, input);
    const row = await implementation.update(input as never);
    if (row === null) return null;
    validateResult(
      input.model,
      row,
      input.select as readonly string[] | undefined,
    );
    return selectRow<"bundles", TSelect>(row, input.select);
  }

  async function deleteRows(input: DeleteDatabaseInput<any>): Promise<void> {
    validateModel(input.model);
    if (input.model !== "bundles" && input.model !== "bundle_patches") {
      throw new DatabaseAdapterInputError("invalid-operation");
    }
    validateWhere(input.model, input.where);
    validateMutationWhere(input.where);
    await implementation.delete(input as never);
  }

  async function count(input: CountDatabaseInput<any>): Promise<number> {
    validateModel(input.model);
    validateWhere(input.model, input.where);
    validateDistinctFields(
      input.model,
      (input as { distinct?: readonly string[] }).distinct,
    );
    const value = await implementation.count(input as never);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DatabaseAdapterInputError("invalid-result");
    }
    return value;
  }

  async function findOne<
    TModel extends DatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindOneDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect> | null> {
    validateModel(input.model);
    validateWhere(input.model, input.where);
    validateSelect(input.model, input.select);
    const row = await implementation.findOne(input as never);
    if (row === null) return null;
    validateResult(
      input.model,
      row,
      input.select as readonly string[] | undefined,
    );
    return selectRow<TModel, TSelect>(row, input.select);
  }

  async function findMany<
    TModel extends DatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindManyDatabaseInput<TModel, TSelect>,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>[]> {
    validateModel(input.model);
    validateWhere(input.model, input.where);
    validatePagination(input.limit, input.offset);
    validateSelect(input.model, input.select);
    const explicitOrderBy = (input as { orderBy?: readonly OrderByClause[] })
      .orderBy;
    const legacySortBy = (input as { sortBy?: OrderByClause }).sortBy;
    const orderBy = validateOrderBy(
      input.model,
      explicitOrderBy ?? (legacySortBy ? [legacySortBy] : undefined),
    );
    validateDistinctOn(
      input.model,
      (input as { distinctOn?: unknown }).distinctOn,
      orderBy,
    );
    const rows = await implementation.findMany({
      ...input,
      limit: input.limit ?? 100,
      offset: input.offset ?? 0,
    } as never);
    if (!Array.isArray(rows)) {
      throw new DatabaseAdapterInputError("invalid-result");
    }
    rows.forEach((row) =>
      validateResult(
        input.model,
        row,
        input.select as readonly string[] | undefined,
      ),
    );
    return rows.map((row) => selectRow<TModel, TSelect>(row, input.select));
  }

  return {
    create: create as DatabaseAdapter["create"],
    update: update as DatabaseAdapter["update"],
    delete: deleteRows as DatabaseAdapter["delete"],
    count: count as DatabaseAdapter["count"],
    findOne: findOne as DatabaseAdapter["findOne"],
    findMany: findMany as DatabaseAdapter["findMany"],
  };
};
