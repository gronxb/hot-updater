import {
  DatabasePluginInputError,
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
} from "./databasePluginCrudValidation";
import type {
  CountDatabaseInput,
  CreateDatabaseInput,
  DatabasePlugin,
  DatabasePluginImplementation,
  DatabaseModel,
  DatabaseSelect,
  DeleteDatabaseInput,
  FindManyDatabaseInput,
  FindOneDatabaseInput,
  SelectedDatabaseRow,
  UpdateDatabaseInput,
} from "./types";

export {
  DatabasePluginInputError,
  type DatabasePluginInputErrorCode,
} from "./databasePluginCrudValidation";

export type DatabasePluginCrud = Pick<
  DatabasePlugin,
  "count" | "create" | "delete" | "findMany" | "findOne" | "update"
>;

export const createDatabasePluginCrud = (
  implementation: DatabasePluginImplementation,
): DatabasePluginCrud => {
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
      throw new DatabasePluginInputError("invalid-operation");
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
      throw new DatabasePluginInputError("invalid-operation");
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
      throw new DatabasePluginInputError("invalid-result");
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
      orderBy,
      limit: input.limit ?? 100,
      offset: input.offset ?? 0,
    } as never);
    if (!Array.isArray(rows)) {
      throw new DatabasePluginInputError("invalid-result");
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
    create: create as DatabasePlugin["create"],
    update: update as DatabasePlugin["update"],
    delete: deleteRows as DatabasePlugin["delete"],
    count: count as DatabasePlugin["count"],
    findOne: findOne as DatabasePlugin["findOne"],
    findMany: findMany as DatabasePlugin["findMany"],
  };
};
