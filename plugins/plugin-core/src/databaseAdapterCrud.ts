import {
  DatabaseAdapterInputError,
  selectRow,
  validateBundleCreateChannel,
  validateBundleTargetUpdate,
  validateBundleUpdateData,
  validateChannelReference,
  validateChannelUpdate,
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

export type DatabaseAdapterCrud<TContext> = Pick<
  DatabaseAdapter<TContext>,
  "count" | "create" | "delete" | "findMany" | "findOne" | "update"
>;

export const createDatabaseAdapterCrud = <TContext>(
  implementation: DatabaseAdapterImplementation<TContext>,
): DatabaseAdapterCrud<TContext> => {
  async function create<
    TModel extends DatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: CreateDatabaseInput<TModel, TSelect>,
    context?: TContext,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>> {
    validateModel(input.model);
    validateCreateData(input.model, input.data);
    if (input.model === "bundles") {
      const bundleInput = input as CreateDatabaseInput<
        "bundles",
        DatabaseSelect<"bundles"> | undefined
      >;
      validateBundleCreateChannel(bundleInput);
      await validateChannelReference(
        implementation,
        bundleInput.data.channel,
        bundleInput.data.channel_id,
        context,
      );
    }
    validateSelect(input.model, input.select);
    const row = await implementation.create(input as never, context);
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
    context?: TContext,
  ): Promise<SelectedDatabaseRow<"bundles", TSelect> | null> {
    validateModel(input.model);
    if (input.model !== "bundles") {
      throw new DatabaseAdapterInputError("invalid-operation");
    }
    validateWhere(input.model, input.where);
    validateMutationWhere(input.where);
    validateUpdateWhere(input.where);
    validateBundleUpdateData(input.update);
    validateChannelUpdate(input.update);
    validateSelect(input.model, input.select);
    await validateBundleTargetUpdate(implementation, input, context);
    if (
      input.update.channel !== undefined &&
      input.update.channel_id !== undefined
    ) {
      await validateChannelReference(
        implementation,
        input.update.channel,
        input.update.channel_id,
        context,
      );
    }
    const row = await implementation.update(input as never, context);
    if (row === null) return null;
    validateResult(
      input.model,
      row,
      input.select as readonly string[] | undefined,
    );
    return selectRow<"bundles", TSelect>(row, input.select);
  }

  async function deleteRows(
    input: DeleteDatabaseInput<any>,
    context?: TContext,
  ): Promise<void> {
    validateModel(input.model);
    if (input.model !== "bundles" && input.model !== "bundle_patches") {
      throw new DatabaseAdapterInputError("invalid-operation");
    }
    validateWhere(input.model, input.where);
    validateMutationWhere(input.where);
    await implementation.delete(input as never, context);
  }

  async function count(
    input: CountDatabaseInput<any>,
    context?: TContext,
  ): Promise<number> {
    validateModel(input.model);
    validateWhere(input.model, input.where);
    validateDistinctFields(
      input.model,
      (input as { distinct?: readonly string[] }).distinct,
    );
    const value = await implementation.count(input as never, context);
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
    context?: TContext,
  ): Promise<SelectedDatabaseRow<TModel, TSelect> | null> {
    validateModel(input.model);
    validateWhere(input.model, input.where);
    validateSelect(input.model, input.select);
    const row = await implementation.findOne(input as never, context);
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
    context?: TContext,
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
    const rows = await implementation.findMany(
      {
        ...input,
        limit: input.limit ?? 100,
        offset: input.offset ?? 0,
      } as never,
      context,
    );
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
    create: create as DatabaseAdapter<TContext>["create"],
    update: update as DatabaseAdapter<TContext>["update"],
    delete: deleteRows as DatabaseAdapter<TContext>["delete"],
    count: count as DatabaseAdapter<TContext>["count"],
    findOne: findOne as DatabaseAdapter<TContext>["findOne"],
    findMany: findMany as DatabaseAdapter<TContext>["findMany"],
  };
};
