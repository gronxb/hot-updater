import type {
  CreateDatabaseInput,
  DatabaseDeleteModel,
  DatabaseFindOneModel,
  DatabaseImplementationResult,
  DatabaseModel,
  DatabaseAdapter,
  DatabaseAdapterImplementation,
  DatabaseRow,
  DatabaseSelect,
  DatabaseWhere,
  DeleteDatabaseInput,
  FindManyDatabaseInput,
  FindOneDatabaseInput,
  SelectedDatabaseRow,
  TransactionDatabaseAdapter,
  TransactionDatabaseAdapterImplementation,
  UpdateBundleDatabaseInput,
} from "./types";
import { databaseFields } from "./types/databaseFields";

export type DatabaseAdapterInputErrorCode =
  | "channel-reference-mismatch"
  | "empty-mutation-where"
  | "empty-select"
  | "incomplete-channel-create"
  | "incomplete-channel-update"
  | "invalid-data"
  | "invalid-field"
  | "invalid-model"
  | "invalid-operation"
  | "invalid-query"
  | "invalid-result"
  | "invalid-pagination"
  | "invalid-update-selector";

export class DatabaseAdapterInputError extends Error {
  readonly code: DatabaseAdapterInputErrorCode;

  constructor(code: DatabaseAdapterInputErrorCode) {
    super(`Invalid database adapter input: ${code}`);
    this.name = "DatabaseAdapterInputError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateSelect = (model: DatabaseModel, select: unknown): void => {
  if (select === undefined) return;
  if (
    !Array.isArray(select) ||
    !select.every((field) => typeof field === "string")
  ) {
    throw new DatabaseAdapterInputError("invalid-query");
  }
  if (select.length === 0) {
    throw new DatabaseAdapterInputError("empty-select");
  }
  validateFields(model, select);
};

const validateModel = (model: DatabaseModel): void => {
  if (!Object.hasOwn(databaseFields, model)) {
    throw new DatabaseAdapterInputError("invalid-model");
  }
};

const validateOperationModel = (
  model: unknown,
  allowedModels: readonly DatabaseModel[],
): void => {
  if (
    typeof model !== "string" ||
    !allowedModels.some((candidate) => candidate === model)
  ) {
    throw new DatabaseAdapterInputError("invalid-operation");
  }
};

const validateField = (model: DatabaseModel, field: string): void => {
  validateModel(model);
  if (!databaseFields[model].some((candidate) => candidate === field)) {
    throw new DatabaseAdapterInputError("invalid-field");
  }
};

const validateFields = (
  model: DatabaseModel,
  fields: readonly string[],
): void => {
  for (const field of fields) validateField(model, field);
};

const databaseWhereOperators = new Set([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
]);

const validateQueryFields = (model: DatabaseModel, input: unknown): void => {
  validateModel(model);
  if (!isRecord(input)) {
    throw new DatabaseAdapterInputError("invalid-query");
  }
  validateSelect(model, input.select);

  if (input.where !== undefined) {
    if (!Array.isArray(input.where)) {
      throw new DatabaseAdapterInputError("invalid-query");
    }
    for (const condition of input.where) {
      if (
        !isRecord(condition) ||
        typeof condition.field !== "string" ||
        !Object.hasOwn(condition, "value") ||
        condition.value === undefined ||
        (condition.operator !== undefined &&
          (typeof condition.operator !== "string" ||
            !databaseWhereOperators.has(condition.operator))) ||
        (condition.connector !== undefined &&
          condition.connector !== "AND" &&
          condition.connector !== "OR") ||
        (condition.mode !== undefined &&
          condition.mode !== "sensitive" &&
          condition.mode !== "insensitive") ||
        ((condition.operator === "in" || condition.operator === "not_in") &&
          !Array.isArray(condition.value))
      ) {
        throw new DatabaseAdapterInputError("invalid-query");
      }
      validateField(model, condition.field);
      validateWhereValue(model, condition);
    }
  }

  if (input.sortBy !== undefined) {
    if (
      !isRecord(input.sortBy) ||
      typeof input.sortBy.field !== "string" ||
      (input.sortBy.direction !== "asc" && input.sortBy.direction !== "desc")
    ) {
      throw new DatabaseAdapterInputError("invalid-query");
    }
    validateField(model, input.sortBy.field);
    if (
      !isStringField(model, input.sortBy.field) &&
      !isNumberField(model, input.sortBy.field)
    ) {
      throw new DatabaseAdapterInputError("invalid-query");
    }
  }
};

const isNullableString = (value: unknown): boolean =>
  value === null || typeof value === "string";

const isStringArrayOrNull = (value: unknown): boolean =>
  value === null ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

const isValidBundleField = (field: string, value: unknown): boolean => {
  switch (field) {
    case "id":
    case "file_hash":
    case "channel":
    case "channel_id":
    case "storage_uri":
      return typeof value === "string";
    case "platform":
      return value === "ios" || value === "android";
    case "should_force_update":
    case "enabled":
      return typeof value === "boolean";
    case "git_commit_hash":
    case "message":
    case "target_app_version":
    case "fingerprint_hash":
    case "manifest_storage_uri":
    case "manifest_file_hash":
    case "asset_base_storage_uri":
      return isNullableString(value);
    case "metadata":
      return value !== undefined;
    case "rollout_cohort_count":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 1000
      );
    case "target_cohorts":
      return isStringArrayOrNull(value);
    default:
      return false;
  }
};

const isValidFieldValue = (
  model: DatabaseModel,
  field: string,
  value: unknown,
): boolean => {
  switch (model) {
    case "bundles":
      return isValidBundleField(field, value);
    case "bundle_patches":
      if (field === "order_index") {
        return (
          typeof value === "number" && Number.isInteger(value) && value >= 0
        );
      }
      return typeof value === "string";
    case "channels":
      return typeof value === "string";
  }
};

const nonStringBundleFields = new Set([
  "should_force_update",
  "enabled",
  "metadata",
  "rollout_cohort_count",
  "target_cohorts",
]);

const isStringField = (model: DatabaseModel, field: string): boolean => {
  switch (model) {
    case "bundles":
      return !nonStringBundleFields.has(field);
    case "bundle_patches":
      return field !== "order_index";
    case "channels":
      return true;
  }
};

const isNumberField = (model: DatabaseModel, field: string): boolean =>
  (model === "bundles" && field === "rollout_cohort_count") ||
  (model === "bundle_patches" && field === "order_index");

const isBooleanField = (model: DatabaseModel, field: string): boolean =>
  model === "bundles" &&
  (field === "should_force_update" || field === "enabled");

const isValidEqualityValue = (
  model: DatabaseModel,
  field: string,
  value: unknown,
): boolean =>
  (isStringField(model, field) ||
    isNumberField(model, field) ||
    isBooleanField(model, field)) &&
  isValidFieldValue(model, field, value);

const validateWhereValue = (
  model: DatabaseModel,
  condition: Readonly<Record<string, unknown>>,
): void => {
  const field = condition.field;
  if (typeof field !== "string") {
    throw new DatabaseAdapterInputError("invalid-query");
  }
  const operator = condition.operator ?? "eq";
  const value = condition.value;
  let valid = false;
  switch (operator) {
    case "eq":
    case "ne":
      valid = isValidEqualityValue(model, field, value);
      break;
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      valid =
        (isStringField(model, field) || isNumberField(model, field)) &&
        value !== null &&
        isValidFieldValue(model, field, value);
      break;
    case "in":
    case "not_in":
      valid =
        Array.isArray(value) &&
        (isStringField(model, field) ||
          isNumberField(model, field) ||
          isBooleanField(model, field)) &&
        value.every((item) => isValidFieldValue(model, field, item));
      break;
    case "contains":
    case "starts_with":
    case "ends_with":
      valid =
        isStringField(model, field) &&
        typeof value === "string" &&
        isValidFieldValue(model, field, value);
      break;
  }
  if (
    condition.mode !== undefined &&
    (!isStringField(model, field) ||
      typeof value !== "string" ||
      (operator !== "eq" &&
        operator !== "ne" &&
        operator !== "contains" &&
        operator !== "starts_with" &&
        operator !== "ends_with"))
  ) {
    valid = false;
  }
  if (!valid) {
    throw new DatabaseAdapterInputError("invalid-query");
  }
};

const validateCreateData = (model: DatabaseModel, data: unknown): void => {
  if (!isRecord(data)) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
  const fields = Object.keys(data);
  validateFields(model, fields);
  if (
    databaseFields[model].some((field) => !Object.hasOwn(data, field)) ||
    fields.some((field) => !isValidFieldValue(model, field, data[field])) ||
    (model === "bundles" &&
      data.target_app_version === null &&
      data.fingerprint_hash === null)
  ) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
};

const validateBundleTargetUpdate = async <TContext>(
  implementation: DatabaseAdapterImplementation<TContext>,
  input: UpdateBundleDatabaseInput<DatabaseSelect<"bundles"> | undefined>,
  context: TContext | undefined,
): Promise<void> => {
  if (
    !Object.hasOwn(input.update, "target_app_version") &&
    !Object.hasOwn(input.update, "fingerprint_hash")
  ) {
    return;
  }
  const id = input.where[0]?.value;
  if (typeof id !== "string") return;
  const current = await implementation.findOne(
    {
      model: "bundles",
      where: [{ field: "id", value: id }],
      select: ["target_app_version", "fingerprint_hash"],
    },
    context,
  );
  if (current === null) return;
  if (!isRecord(current)) {
    throw new DatabaseAdapterInputError("invalid-result");
  }
  const currentTargetAppVersion = Reflect.get(current, "target_app_version");
  const currentFingerprintHash = Reflect.get(current, "fingerprint_hash");
  if (
    !Object.hasOwn(current, "target_app_version") ||
    !Object.hasOwn(current, "fingerprint_hash") ||
    !isNullableString(currentTargetAppVersion) ||
    !isNullableString(currentFingerprintHash)
  ) {
    throw new DatabaseAdapterInputError("invalid-result");
  }
  const targetAppVersion = Object.hasOwn(input.update, "target_app_version")
    ? input.update.target_app_version
    : currentTargetAppVersion;
  const fingerprintHash = Object.hasOwn(input.update, "fingerprint_hash")
    ? input.update.fingerprint_hash
    : currentFingerprintHash;
  if (targetAppVersion === null && fingerprintHash === null) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
};

const validateBundleUpdateData = (update: unknown): void => {
  if (!isRecord(update)) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
  const fields = Object.keys(update);
  validateFields("bundles", fields);
  if (
    fields.includes("id") ||
    fields.some((field) => !isValidBundleField(field, update[field]))
  ) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
};

const validatePagination = (
  limit: number | undefined,
  offset: number | undefined,
): void => {
  if (
    (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) ||
    (offset !== undefined && (!Number.isInteger(offset) || offset < 0))
  ) {
    throw new DatabaseAdapterInputError("invalid-pagination");
  }
};

const validateMutationWhere = (
  where:
    | readonly DatabaseWhere<"bundle_patches">[]
    | readonly DatabaseWhere<"bundles">[],
): void => {
  if (where.length === 0) {
    throw new DatabaseAdapterInputError("empty-mutation-where");
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
    throw new DatabaseAdapterInputError("invalid-update-selector");
  }
};

const validateChannelUpdate = (
  update: UpdateBundleDatabaseInput["update"],
): void => {
  const hasChannel = Object.hasOwn(update, "channel");
  const hasChannelId = Object.hasOwn(update, "channel_id");
  if (hasChannel !== hasChannelId) {
    throw new DatabaseAdapterInputError("incomplete-channel-update");
  }
};

const validateBundleCreateChannel = (input: AnyCreateInput): void => {
  if (input.model !== "bundles") return;
  if (
    !isRecord(input.data) ||
    !Object.hasOwn(input.data, "channel") ||
    !Object.hasOwn(input.data, "channel_id")
  ) {
    throw new DatabaseAdapterInputError("incomplete-channel-create");
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
  if (
    !isRecord(row) ||
    requiredFields.some(
      (field) =>
        !Object.hasOwn(row, field) ||
        !isValidFieldValue(model, field, Reflect.get(row, field)),
    )
  ) {
    throw new DatabaseAdapterInputError("invalid-result");
  }
  if (
    model === "bundles" &&
    Object.hasOwn(row, "target_app_version") &&
    Object.hasOwn(row, "fingerprint_hash") &&
    Reflect.get(row, "target_app_version") === null &&
    Reflect.get(row, "fingerprint_hash") === null
  ) {
    throw new DatabaseAdapterInputError("invalid-result");
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

export type DatabaseAdapterCrud<TContext> = Pick<
  DatabaseAdapter<TContext>,
  "count" | "create" | "delete" | "findMany" | "findOne" | "update"
>;

export const createDatabaseAdapterCrud = <TContext>(
  implementation: DatabaseAdapterImplementation<TContext>,
): DatabaseAdapterCrud<TContext> => {
  const validateChannelReference = async (
    channel: string,
    channelId: string,
    context: TContext | undefined,
  ): Promise<void> => {
    const stored = await implementation.findOne(
      {
        model: "channels",
        where: [{ field: "id", value: channelId }],
        select: ["name"],
      },
      context,
    );
    if (stored === null) {
      throw new DatabaseAdapterInputError("channel-reference-mismatch");
    }
    if (!isRecord(stored)) {
      throw new DatabaseAdapterInputError("invalid-result");
    }
    const storedName = Reflect.get(stored, "name");
    if (typeof storedName !== "string") {
      throw new DatabaseAdapterInputError("invalid-result");
    }
    if (storedName !== channel) {
      throw new DatabaseAdapterInputError("channel-reference-mismatch");
    }
  };

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
    validateQueryFields(input.model, input);
    validateBundleCreateChannel(input);
    validateCreateData(input.model, input.data);
    if (input.model === "bundles") {
      await validateChannelReference(
        input.data.channel,
        input.data.channel_id,
        context,
      );
    }
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
    validateOperationModel(input.model, ["bundles"]);
    validateQueryFields(input.model, input);
    validateBundleUpdateData(input.update);
    validateUpdateWhere(input.where);
    validateChannelUpdate(input.update);
    await validateBundleTargetUpdate(implementation, input, context);
    if (
      input.update.channel !== undefined &&
      input.update.channel_id !== undefined
    ) {
      await validateChannelReference(
        input.update.channel,
        input.update.channel_id,
        context,
      );
    }
    const row = await implementation.update(input, context);
    if (row === null) return null;
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
    validateOperationModel(input.model, ["bundles", "channels"]);
    validateQueryFields(input.model, input);
    const row = await implementation.findOne(input, context);
    if (row === null) return null;
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
    validateQueryFields(input.model, input);
    validatePagination(input.limit, input.offset);
    const rows = await implementation.findMany(
      { ...input, limit: input.limit ?? 100, offset: input.offset ?? 0 },
      context,
    );
    if (!Array.isArray(rows)) {
      throw new DatabaseAdapterInputError("invalid-result");
    }
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
    validateOperationModel(input.model, ["bundles", "bundle_patches"]);
    validateQueryFields(input.model, input);
    validateMutationWhere(input.where);
    return implementation.delete(input, context);
  }

  return {
    create,
    update,
    delete: deleteRows,
    count: async (input, context) => {
      validateOperationModel(input.model, ["bundles"]);
      validateQueryFields(input.model, input);
      const result = await implementation.count(input, context);
      if (!Number.isSafeInteger(result) || result < 0) {
        throw new DatabaseAdapterInputError("invalid-result");
      }
      return result;
    },
    findOne,
    findMany,
  };
};

export const createTransactionDatabaseAdapter = (
  implementation: TransactionDatabaseAdapterImplementation,
): TransactionDatabaseAdapter => {
  const contextualImplementation: DatabaseAdapterImplementation<undefined> = {
    ...implementation,
  };
  return createDatabaseAdapterCrud(contextualImplementation);
};
