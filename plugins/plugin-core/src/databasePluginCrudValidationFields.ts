import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import type { DatabaseModel } from "./types";
import { databaseFields } from "./types/databaseFields";

export type ValidatorMap = Record<
  DatabaseModel,
  Record<string, (value: unknown) => boolean>
>;

export type OrderByClause = {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly nulls?: "first" | "last";
};

export const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const modelValidators: ValidatorMap = {
  bundles: {
    id: (value) => typeof value === "string",
    platform: (value) => value === "ios" || value === "android",
    should_force_update: (value) => typeof value === "boolean",
    enabled: (value) => typeof value === "boolean",
    file_hash: (value) => typeof value === "string",
    git_commit_hash: (value) => value === null || typeof value === "string",
    message: (value) => value === null || typeof value === "string",
    channel: (value) => typeof value === "string",
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
  bundle_events: {
    id: (value) => typeof value === "string",
    type: (value) =>
      value === "UPDATE_APPLIED" ||
      value === "RECOVERED" ||
      value === "UNCHANGED",
    install_id: (value) => typeof value === "string",
    user_id: (value) => value === null || typeof value === "string",
    username: (value) => value === null || typeof value === "string",
    from_bundle_id: (value) => value === null || typeof value === "string",
    to_bundle_id: (value) => typeof value === "string",
    platform: (value) => value === "ios" || value === "android",
    app_version: (value) => typeof value === "string",
    channel: (value) => typeof value === "string",
    cohort: (value) => typeof value === "string",
    update_strategy: (value) =>
      value === null || value === "fingerprint" || value === "appVersion",
    fingerprint_hash: (value) => value === null || typeof value === "string",
    sdk_version: (value) => value === null || typeof value === "string",
    received_at_ms: (value) =>
      typeof value === "number" && Number.isFinite(value),
  },
};

export const stringFields = new Set<string>([
  "id",
  "platform",
  "file_hash",
  "git_commit_hash",
  "message",
  "channel",
  "storage_uri",
  "target_app_version",
  "fingerprint_hash",
  "bundle_id",
  "base_bundle_id",
  "base_file_hash",
  "patch_file_hash",
  "patch_storage_uri",
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

export const numberFields = new Set<string>([
  "rollout_cohort_count",
  "order_index",
  "received_at_ms",
]);

export const booleanFields = new Set<string>([
  "should_force_update",
  "enabled",
]);

export const sortableFields: Record<DatabaseModel, ReadonlySet<string>> = {
  bundles: new Set([
    "id",
    "platform",
    "file_hash",
    "git_commit_hash",
    "message",
    "channel",
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

export const validateModel: (
  model: unknown,
) => asserts model is DatabaseModel = (model) => {
  if (typeof model !== "string" || !Object.hasOwn(databaseFields, model)) {
    throw new DatabasePluginInputError("invalid-model");
  }
};

export const validateField = (model: DatabaseModel, field: string): void => {
  if (!(databaseFields[model] as readonly string[]).includes(field)) {
    throw new DatabasePluginInputError("invalid-field");
  }
};

export const validateFields = (
  model: DatabaseModel,
  fields: readonly string[],
): void => {
  for (const field of fields) validateField(model, field);
};

export const isStringField = (field: string): boolean =>
  stringFields.has(field);
export const isNumberField = (field: string): boolean =>
  numberFields.has(field);
export const isBooleanField = (field: string): boolean =>
  booleanFields.has(field);
