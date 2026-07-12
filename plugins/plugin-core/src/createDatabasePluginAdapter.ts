import type {
  CreateDatabaseInput,
  DatabaseDeleteModel,
  DatabaseFindOneModel,
  DatabaseImplementationResult,
  DatabaseModel,
  DatabasePlugin,
  DatabasePluginImplementation,
  DatabaseRow,
  DatabaseSelect,
  DatabaseWhere,
  DeleteDatabaseInput,
  FindManyDatabaseInput,
  FindOneDatabaseInput,
  SelectedDatabaseRow,
  TransactionDatabasePlugin,
  TransactionDatabasePluginImplementation,
  UpdateBundleDatabaseInput,
} from "./types";
import { databaseFields } from "./types/databaseFields";

export type DatabasePluginInputErrorCode =
  | "empty-mutation-where"
  | "empty-select"
  | "invalid-result"
  | "invalid-pagination"
  | "invalid-update-selector";

export class DatabasePluginInputError extends Error {
  readonly code: DatabasePluginInputErrorCode;

  constructor(code: DatabasePluginInputErrorCode) {
    super(`Invalid database plugin input: ${code}`);
    this.name = "DatabasePluginInputError";
    this.code = code;
  }
}

const validateSelect = (select: readonly string[] | undefined): void => {
  if (select?.length === 0) {
    throw new DatabasePluginInputError("empty-select");
  }
};

const validatePagination = (
  limit: number | undefined,
  offset: number | undefined,
): void => {
  if (
    (limit !== undefined && limit < 0) ||
    (offset !== undefined && offset < 0)
  ) {
    throw new DatabasePluginInputError("invalid-pagination");
  }
};

const validateMutationWhere = (
  where:
    | readonly DatabaseWhere<"bundle_patches">[]
    | readonly DatabaseWhere<"bundles">[],
): void => {
  if (where.length === 0) {
    throw new DatabasePluginInputError("empty-mutation-where");
  }
};

const validateUpdateWhere = (
  where: readonly DatabaseWhere<"bundles">[],
): void => {
  const selector = where[0];
  if (
    where.length !== 1 ||
    selector?.field !== "id" ||
    (selector.operator !== undefined && selector.operator !== "eq") ||
    typeof selector.value !== "string"
  ) {
    throw new DatabasePluginInputError("invalid-update-selector");
  }
};

function selectRow<
  TModel extends DatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined,
>(
  row: DatabaseRow<TModel>,
  select: TSelect,
): SelectedDatabaseRow<TModel, TSelect>;
function selectRow(
  row: DatabaseImplementationResult,
  select: readonly string[] | undefined,
): object;
function selectRow(
  row: DatabaseImplementationResult,
  select: readonly string[] | undefined,
): object {
  if (!select) {
    return row;
  }
  return Object.fromEntries(
    Object.entries(row).filter(([field]) => select.includes(field)),
  );
}

const validateResult = (
  model: DatabaseModel,
  row: DatabaseImplementationResult,
  select: readonly string[] | undefined,
): void => {
  const requiredFields = select ?? databaseFields[model];
  if (requiredFields.some((field) => !(field in row))) {
    throw new DatabasePluginInputError("invalid-result");
  }
};

type AnyCreateInput = {
  readonly [TModel in DatabaseModel]: CreateDatabaseInput<
    TModel,
    DatabaseSelect<TModel> | undefined
  >;
}[DatabaseModel];

type AnyFindOneInput = {
  readonly [TModel in DatabaseFindOneModel]: FindOneDatabaseInput<
    TModel,
    DatabaseSelect<TModel> | undefined
  >;
}[DatabaseFindOneModel];

type AnyFindManyInput = {
  readonly [TModel in DatabaseModel]: FindManyDatabaseInput<
    TModel,
    DatabaseSelect<TModel> | undefined
  >;
}[DatabaseModel];

type AnyDeleteInput = {
  readonly [TModel in DatabaseDeleteModel]: DeleteDatabaseInput<TModel>;
}[DatabaseDeleteModel];

export type DatabasePluginCrud<TContext> = Pick<
  DatabasePlugin<TContext>,
  "count" | "create" | "delete" | "findMany" | "findOne" | "update"
>;

export const createDatabasePluginCrud = <TContext>(
  implementation: DatabasePluginImplementation<TContext>,
): DatabasePluginCrud<TContext> => {
  function create<
    TModel extends DatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: CreateDatabaseInput<TModel, TSelect>,
    context?: TContext,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>>;
  async function create(
    input: AnyCreateInput,
    context?: TContext,
  ): Promise<object> {
    validateSelect(input.select);
    const row = await implementation.create(input, context);
    validateResult(input.model, row, input.select);
    return selectRow(row, input.select);
  }

  function update<
    TSelect extends DatabaseSelect<"bundles"> | undefined = undefined,
  >(
    input: UpdateBundleDatabaseInput<TSelect>,
    context?: TContext,
  ): Promise<SelectedDatabaseRow<"bundles", TSelect> | null>;
  async function update(
    input: UpdateBundleDatabaseInput<DatabaseSelect<"bundles"> | undefined>,
    context?: TContext,
  ): Promise<object | null> {
    validateSelect(input.select);
    validateUpdateWhere(input.where);
    const row = await implementation.update(input, context);
    if (!row) return null;
    validateResult(input.model, row, input.select);
    return selectRow(row, input.select);
  }

  function findOne<
    TModel extends DatabaseFindOneModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindOneDatabaseInput<TModel, TSelect>,
    context?: TContext,
  ): Promise<SelectedDatabaseRow<TModel, TSelect> | null>;
  async function findOne(
    input: AnyFindOneInput,
    context?: TContext,
  ): Promise<object | null> {
    validateSelect(input.select);
    const row = await implementation.findOne(input, context);
    if (!row) return null;
    validateResult(input.model, row, input.select);
    return selectRow(row, input.select);
  }

  function findMany<
    TModel extends DatabaseModel,
    TSelect extends DatabaseSelect<TModel> | undefined = undefined,
  >(
    input: FindManyDatabaseInput<TModel, TSelect>,
    context?: TContext,
  ): Promise<SelectedDatabaseRow<TModel, TSelect>[]>;
  async function findMany(
    input: AnyFindManyInput,
    context?: TContext,
  ): Promise<object[]> {
    validateSelect(input.select);
    validatePagination(input.limit, input.offset);
    const rows = await implementation.findMany(
      { ...input, limit: input.limit ?? 100, offset: input.offset ?? 0 },
      context,
    );
    return rows.map((row) => {
      validateResult(input.model, row, input.select);
      return selectRow(row, input.select);
    });
  }

  function deleteRows<TModel extends DatabaseDeleteModel>(
    input: DeleteDatabaseInput<TModel>,
    context?: TContext,
  ): Promise<void>;
  async function deleteRows(
    input: AnyDeleteInput,
    context?: TContext,
  ): Promise<void> {
    validateMutationWhere(input.where);
    return implementation.delete(input, context);
  }

  return {
    create,
    update,
    delete: deleteRows,
    count: (input, context) => implementation.count(input, context),
    findOne,
    findMany,
  };
};

export const createTransactionDatabasePlugin = (
  implementation: TransactionDatabasePluginImplementation,
): TransactionDatabasePlugin => {
  const contextualImplementation: DatabasePluginImplementation<undefined> = {
    ...implementation,
  };
  return createDatabasePluginCrud(contextualImplementation);
};
