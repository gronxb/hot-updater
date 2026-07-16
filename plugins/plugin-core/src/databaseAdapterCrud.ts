import type {
  CountDatabaseInput,
  CreateDatabaseInput,
  DatabaseAdapter,
  DatabaseAdapterImplementation,
  DatabaseImplementationResult,
  DatabaseModel,
  DatabaseSelect,
  DeleteDatabaseInput,
  FindManyDatabaseInput,
  FindOneDatabaseInput,
  SelectedDatabaseRow,
  TransactionDatabaseAdapter,
  TransactionDatabaseAdapterImplementation,
  UpdateDatabaseInput,
} from "./types";
import { databaseFields } from "./types/databaseFields";

export type DatabaseAdapterInputErrorCode =
  | "channel-reference-mismatch"
  | "empty-mutation-where"
  | "empty-select"
  | "incomplete-channel-create"
  | "incomplete-channel-update"
  | "invalid-data"
  | "invalid-distinct"
  | "invalid-field"
  | "invalid-model"
  | "invalid-operation"
  | "invalid-query"
  | "invalid-result"
  | "invalid-pagination"
  | "invalid-update-selector";

export class DatabaseAdapterInputError extends Error {
  readonly name = "DatabaseAdapterInputError";

  constructor(readonly code: DatabaseAdapterInputErrorCode) {
    super(`Invalid database adapter input: ${code}`);
  }
}

type ValidatorMap = Record<
  DatabaseModel,
  Record<string, (value: unknown) => boolean>
>;
type OrderByClause = {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly nulls?: "first" | "last";
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const modelValidators: ValidatorMap = {
  bundles: {
    id: (value) => typeof value === "string",
    platform: (value) => value === "ios" || value === "android",
    should_force_update: (value) => typeof value === "boolean",
    enabled: (value) => typeof value === "boolean",
    file_hash: (value) => typeof value === "string",
    git_commit_hash: (value) => value === null || typeof value === "string",
    message: (value) => value === null || typeof value === "string",
    channel: (value) => typeof value === "string",
    channel_id: (value) => typeof value === "string",
    storage_uri: (value) => typeof value === "string",
    target_app_version: (value) => value === null || typeof value === "string",
    fingerprint_hash: (value) => value === null || typeof value === "string",
    metadata: (value) => value !== undefined,
    rollout_cohort_count: (value) =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 1000,
    target_cohorts: (value) =>
      value === null ||
      (Array.isArray(value) && value.every((item) => typeof item === "string")),
    manifest_storage_uri: (value) =>
      value === null || typeof value === "string",
    manifest_file_hash: (value) => value === null || typeof value === "string",
    asset_base_storage_uri: (value) =>
      value === null || typeof value === "string",
  },
  bundle_patches: {
    id: (value) => typeof value === "string",
    bundle_id: (value) => typeof value === "string",
    base_bundle_id: (value) => typeof value === "string",
    base_file_hash: (value) => typeof value === "string",
    patch_file_hash: (value) => typeof value === "string",
    patch_storage_uri: (value) => typeof value === "string",
    order_index: (value) =>
      typeof value === "number" && Number.isInteger(value) && value >= 0,
  },
  channels: {
    id: (value) => typeof value === "string",
    name: (value) => typeof value === "string",
  },
  bundle_events: {
    id: (value) => typeof value === "string",
    type: (value) => value === "UPDATE_APPLIED" || value === "RECOVERED",
    install_id: (value) => typeof value === "string",
    user_id: (value) => value === null || typeof value === "string",
    username: (value) => value === null || typeof value === "string",
    from_bundle_id: (value) => typeof value === "string",
    to_bundle_id: (value) => typeof value === "string",
    platform: (value) => value === "ios" || value === "android",
    app_version: (value) => typeof value === "string",
    channel: (value) => typeof value === "string",
    cohort: (value) => typeof value === "string",
    update_strategy: (value) =>
      value === "fingerprint" || value === "appVersion",
    fingerprint_hash: (value) => value === null || typeof value === "string",
    sdk_version: (value) => value === null || typeof value === "string",
    received_at_ms: (value) =>
      typeof value === "number" && Number.isFinite(value),
  },
};

const stringFields = new Set<string>([
  "id",
  "platform",
  "file_hash",
  "git_commit_hash",
  "message",
  "channel",
  "channel_id",
  "storage_uri",
  "target_app_version",
  "fingerprint_hash",
  "bundle_id",
  "base_bundle_id",
  "base_file_hash",
  "patch_file_hash",
  "patch_storage_uri",
  "name",
  "type",
  "install_id",
  "user_id",
  "username",
  "from_bundle_id",
  "to_bundle_id",
  "app_version",
  "cohort",
  "update_strategy",
  "sdk_version",
]);
const numberFields = new Set<string>([
  "rollout_cohort_count",
  "order_index",
  "received_at_ms",
]);
const booleanFields = new Set<string>(["should_force_update", "enabled"]);
const sortableFields: Record<DatabaseModel, ReadonlySet<string>> = {
  bundles: new Set([
    "id",
    "platform",
    "file_hash",
    "git_commit_hash",
    "message",
    "channel",
    "channel_id",
    "storage_uri",
    "target_app_version",
    "fingerprint_hash",
    "rollout_cohort_count",
    "manifest_storage_uri",
    "manifest_file_hash",
    "asset_base_storage_uri",
  ]),
  bundle_patches: new Set([
    "id",
    "bundle_id",
    "base_bundle_id",
    "base_file_hash",
    "patch_file_hash",
    "patch_storage_uri",
    "order_index",
  ]),
  channels: new Set(["id", "name"]),
  bundle_events: new Set([
    "id",
    "type",
    "install_id",
    "user_id",
    "username",
    "from_bundle_id",
    "to_bundle_id",
    "platform",
    "app_version",
    "channel",
    "cohort",
    "update_strategy",
    "fingerprint_hash",
    "sdk_version",
    "received_at_ms",
  ]),
};

const validateModel: (model: unknown) => asserts model is DatabaseModel = (
  model,
) => {
  if (typeof model !== "string" || !Object.hasOwn(databaseFields, model)) {
    throw new DatabaseAdapterInputError("invalid-model");
  }
};

const validateField = (model: DatabaseModel, field: string): void => {
  if (!(databaseFields[model] as readonly string[]).includes(field)) {
    throw new DatabaseAdapterInputError("invalid-field");
  }
};

const validateFields = (
  model: DatabaseModel,
  fields: readonly string[],
): void => {
  for (const field of fields) validateField(model, field);
};

const isStringField = (field: string): boolean => stringFields.has(field);
const isNumberField = (field: string): boolean => numberFields.has(field);
const isBooleanField = (field: string): boolean => booleanFields.has(field);

const validateSelect = (model: DatabaseModel, select: unknown): void => {
  if (select === undefined) return;
  if (!Array.isArray(select) || select.length === 0) {
    throw new DatabaseAdapterInputError("empty-select");
  }
  if (!select.every((field) => typeof field === "string")) {
    throw new DatabaseAdapterInputError("invalid-query");
  }
  validateFields(model, select);
};

const validateWhereValue = (
  model: DatabaseModel,
  condition: Readonly<Record<string, unknown>>,
): void => {
  const field = condition.field;
  if (typeof field !== "string")
    throw new DatabaseAdapterInputError("invalid-query");
  validateField(model, field);
  const operator = condition.operator ?? "eq";
  const value = condition.value;
  const mode = condition.mode;
  if (mode !== undefined && mode !== "sensitive" && mode !== "insensitive") {
    throw new DatabaseAdapterInputError("invalid-query");
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
        throw new DatabaseAdapterInputError("invalid-query");
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
        throw new DatabaseAdapterInputError("invalid-query");
      }
      return;
    case "in":
    case "not_in":
      if (!Array.isArray(value) || mode !== undefined)
        throw new DatabaseAdapterInputError("invalid-query");
      if (
        !(isStringField(field) || isNumberField(field) || isBooleanField(field))
      ) {
        throw new DatabaseAdapterInputError("invalid-query");
      }
      if (!value.every((item) => modelValidators[model][field]?.(item))) {
        throw new DatabaseAdapterInputError("invalid-query");
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
        throw new DatabaseAdapterInputError("invalid-query");
      }
      return;
    default:
      throw new DatabaseAdapterInputError("invalid-query");
  }
};

const validateWhere = (model: DatabaseModel, where: unknown): void => {
  if (where === undefined) return;
  if (!Array.isArray(where))
    throw new DatabaseAdapterInputError("invalid-query");
  for (const item of where) {
    if (!isRecord(item)) throw new DatabaseAdapterInputError("invalid-query");
    if (
      item.connector !== undefined &&
      item.connector !== "AND" &&
      item.connector !== "OR"
    ) {
      throw new DatabaseAdapterInputError("invalid-query");
    }
    validateWhereValue(model, item);
  }
};

const validateDistinctFields = (
  model: DatabaseModel,
  fields: unknown,
): readonly string[] | undefined => {
  if (fields === undefined) return undefined;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new DatabaseAdapterInputError("invalid-distinct");
  }
  if (!fields.every((field) => typeof field === "string")) {
    throw new DatabaseAdapterInputError("invalid-distinct");
  }
  validateFields(model, fields);
  return fields;
};

const validateOrderBy = (
  model: DatabaseModel,
  orderBy: unknown,
): readonly OrderByClause[] | undefined => {
  if (orderBy === undefined) return undefined;
  if (!Array.isArray(orderBy) || orderBy.length === 0) {
    throw new DatabaseAdapterInputError("invalid-query");
  }
  return orderBy.map((clause) => {
    if (!isRecord(clause) || typeof clause.field !== "string") {
      throw new DatabaseAdapterInputError("invalid-query");
    }
    validateField(model, clause.field);
    if (!sortableFields[model].has(clause.field)) {
      throw new DatabaseAdapterInputError("invalid-query");
    }
    if (clause.direction !== "asc" && clause.direction !== "desc") {
      throw new DatabaseAdapterInputError("invalid-query");
    }
    if (
      clause.nulls !== undefined &&
      clause.nulls !== "first" &&
      clause.nulls !== "last"
    ) {
      throw new DatabaseAdapterInputError("invalid-query");
    }
    return clause as OrderByClause;
  });
};

const validateDistinctOn = (
  model: DatabaseModel,
  distinctOn: unknown,
  orderBy: readonly OrderByClause[] | undefined,
): void => {
  if (distinctOn === undefined) return;
  if (!isRecord(distinctOn))
    throw new DatabaseAdapterInputError("invalid-distinct");
  const fields = validateDistinctFields(model, distinctOn.fields);
  if (fields === undefined || orderBy === undefined) {
    throw new DatabaseAdapterInputError("invalid-distinct");
  }
  for (const [index, field] of fields.entries()) {
    if (orderBy[index]?.field !== field) {
      throw new DatabaseAdapterInputError("invalid-distinct");
    }
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

const validateCreateData = (model: DatabaseModel, data: unknown): void => {
  if (!isRecord(data)) throw new DatabaseAdapterInputError("invalid-data");
  validateFields(model, Object.keys(data));
  for (const field of databaseFields[model]) {
    const validator = modelValidators[model][field];
    if (
      !Object.hasOwn(data, field) ||
      !validator ||
      !validator(Reflect.get(data, field))
    ) {
      throw new DatabaseAdapterInputError("invalid-data");
    }
  }
  if (
    model === "bundles" &&
    data.target_app_version === null &&
    data.fingerprint_hash === null
  ) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
};

const validateBundleCreateChannel = (
  input: CreateDatabaseInput<"bundles", DatabaseSelect<"bundles"> | undefined>,
): void => {
  const hasChannel = Object.hasOwn(input.data, "channel");
  const hasChannelId = Object.hasOwn(input.data, "channel_id");
  if (hasChannel !== hasChannelId) {
    throw new DatabaseAdapterInputError("incomplete-channel-create");
  }
};

const validateMutationWhere = (where: readonly unknown[]): void => {
  if (where.length === 0) {
    throw new DatabaseAdapterInputError("empty-mutation-where");
  }
};

const validateUpdateWhere = (where: readonly unknown[]): void => {
  const selector = where[0];
  if (
    where.length !== 1 ||
    !isRecord(selector) ||
    selector.field !== "id" ||
    (selector.operator !== undefined && selector.operator !== "eq") ||
    typeof selector.value !== "string" ||
    selector.connector !== undefined ||
    selector.mode !== undefined
  ) {
    throw new DatabaseAdapterInputError("invalid-update-selector");
  }
};

const validateChannelUpdate = (
  update: UpdateDatabaseInput<"bundles">["update"],
): void => {
  const hasChannel = Object.hasOwn(update, "channel");
  const hasChannelId = Object.hasOwn(update, "channel_id");
  if (hasChannel !== hasChannelId) {
    throw new DatabaseAdapterInputError("incomplete-channel-update");
  }
};

const validateBundleUpdateData = (update: unknown): void => {
  if (!isRecord(update)) throw new DatabaseAdapterInputError("invalid-data");
  for (const [field, value] of Object.entries(update)) {
    if (field === "id") {
      throw new DatabaseAdapterInputError("invalid-data");
    }
    validateField("bundles", field);
    const validator = modelValidators.bundles[field];
    if (!validator || !validator(value)) {
      throw new DatabaseAdapterInputError("invalid-data");
    }
  }
  if (
    Reflect.get(update, "target_app_version") === null &&
    Reflect.get(update, "fingerprint_hash") === null
  ) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
};

const selectRow = <
  TModel extends DatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined,
>(
  row: DatabaseImplementationResult,
  select: DatabaseSelect<TModel> | undefined,
): SelectedDatabaseRow<TModel, TSelect> => {
  if (!select) return row as SelectedDatabaseRow<TModel, TSelect>;
  return Object.fromEntries(
    select.map((field) => [field, Reflect.get(row, field)]),
  ) as SelectedDatabaseRow<TModel, TSelect>;
};

const validateResult = (
  model: DatabaseModel,
  row: DatabaseImplementationResult,
  select: readonly string[] | undefined,
): void => {
  if (!isRecord(row)) throw new DatabaseAdapterInputError("invalid-result");
  const fields = select ?? databaseFields[model];
  for (const field of fields) {
    const validator = modelValidators[model][field];
    if (
      !Object.hasOwn(row, field) ||
      !validator ||
      !validator(Reflect.get(row, field))
    ) {
      throw new DatabaseAdapterInputError("invalid-result");
    }
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

const validateBundleTargetUpdate = async <TContext>(
  implementation: DatabaseAdapterImplementation<TContext>,
  input: UpdateDatabaseInput<"bundles", DatabaseSelect<"bundles"> | undefined>,
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
  validateResult("bundles", current, [
    "target_app_version",
    "fingerprint_hash",
  ]);
  const targetAppVersion = Object.hasOwn(input.update, "target_app_version")
    ? input.update.target_app_version
    : Reflect.get(current, "target_app_version");
  const fingerprintHash = Object.hasOwn(input.update, "fingerprint_hash")
    ? input.update.fingerprint_hash
    : Reflect.get(current, "fingerprint_hash");
  if (targetAppVersion === null && fingerprintHash === null) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
};

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
    validateResult("channels", stored, ["name"]);
    if (Reflect.get(stored, "name") !== channel) {
      throw new DatabaseAdapterInputError("channel-reference-mismatch");
    }
  };

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

export const createTransactionDatabaseAdapter = (
  implementation: TransactionDatabaseAdapterImplementation,
): TransactionDatabaseAdapter => {
  const contextualImplementation: DatabaseAdapterImplementation<undefined> = {
    ...implementation,
  };
  return createDatabaseAdapterCrud(contextualImplementation);
};
