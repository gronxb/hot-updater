import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabaseModel,
  UpdateInfo,
} from "@hot-updater/plugin-core";
import { databaseFields } from "@hot-updater/plugin-core";

export type StandaloneDatabaseErrorCode =
  | "database-error"
  | "invalid-request"
  | "invalid-response"
  | "request-failed"
  | "unsupported-capability"
  | "unsupported-operation";

export class StandaloneDatabaseError extends Error {
  readonly code: StandaloneDatabaseErrorCode;
  readonly status: number | undefined;

  constructor(
    code: StandaloneDatabaseErrorCode,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "StandaloneDatabaseError";
    this.code = code;
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isNullableStringArray = (
  value: unknown,
): value is readonly string[] | null =>
  value === null ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

const isBundleFieldValue = (
  field: keyof BundleRow,
  value: unknown,
): boolean => {
  switch (field) {
    case "enabled":
    case "should_force_update":
      return typeof value === "boolean";
    case "rollout_cohort_count":
      return typeof value === "number" && Number.isInteger(value);
    case "git_commit_hash":
    case "message":
    case "target_app_version":
    case "fingerprint_hash":
    case "manifest_storage_uri":
    case "manifest_file_hash":
    case "asset_base_storage_uri":
      return isNullableString(value);
    case "target_cohorts":
      return isNullableStringArray(value);
    case "platform":
      return value === "ios" || value === "android";
    case "metadata":
      return true;
    case "id":
    case "file_hash":
    case "channel":
    case "storage_uri":
      return typeof value === "string";
  }
};

const isPatchFieldValue = (
  field: keyof BundlePatchRow,
  value: unknown,
): boolean => {
  if (field === "order_index") {
    return typeof value === "number" && Number.isInteger(value);
  }
  return typeof value === "string";
};

const hasOnlyValidFields = <TField extends string>(
  value: Record<string, unknown>,
  fields: readonly TField[],
  validate: (field: TField, fieldValue: unknown) => boolean,
): boolean =>
  Object.entries(value).every(([candidate, fieldValue]) => {
    const field = fields.find((allowedField) => allowedField === candidate);
    return field !== undefined && validate(field, fieldValue);
  });

const isPartialBundleRow = (value: unknown): value is Partial<BundleRow> =>
  isRecord(value) &&
  hasOnlyValidFields(value, databaseFields.bundles, isBundleFieldValue);

const isPartialPatchRow = (value: unknown): value is Partial<BundlePatchRow> =>
  isRecord(value) &&
  hasOnlyValidFields(value, databaseFields.bundle_patches, isPatchFieldValue);

const isPartialChannelRow = (value: unknown): value is Partial<ChannelRow> =>
  isRecord(value) &&
  hasOnlyValidFields(
    value,
    databaseFields.channels,
    (_field, fieldValue) => typeof fieldValue === "string",
  );

export function isPartialDatabaseRow(
  model: DatabaseModel,
  value: unknown,
): value is Partial<BundleRow> | Partial<BundlePatchRow> | Partial<ChannelRow> {
  switch (model) {
    case "bundles":
      return isPartialBundleRow(value);
    case "bundle_patches":
      return isPartialPatchRow(value);
    case "channels":
      return isPartialChannelRow(value);
  }
}

export const isUpdateInfo = (value: unknown): value is UpdateInfo =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.shouldForceUpdate === "boolean" &&
  isNullableString(value.message) &&
  (value.status === "ROLLBACK" || value.status === "UPDATE") &&
  isNullableString(value.storageUri) &&
  isNullableString(value.fileHash) &&
  (value.rolloutCohortCount === undefined ||
    value.rolloutCohortCount === null ||
    typeof value.rolloutCohortCount === "number") &&
  (value.targetCohorts === undefined ||
    isNullableStringArray(value.targetCohorts));

const parseError = (
  value: unknown,
): {
  readonly code: StandaloneDatabaseErrorCode;
  readonly message: string;
} | null => {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const { code, message } = value.error;
  if (typeof code !== "string" || typeof message !== "string") return null;
  switch (code) {
    case "database-error":
    case "invalid-request":
    case "invalid-response":
    case "request-failed":
    case "unsupported-capability":
    case "unsupported-operation":
      return { code, message };
    default:
      return null;
  }
};

type RequestOptions = {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly input: unknown;
  readonly model: string;
  readonly operation: string;
};

export const requestStandaloneDatabase = async (
  options: RequestOptions,
): Promise<unknown> => {
  const root = options.endpoint.replace(/\/+$/, "");
  const response = await fetch(
    `${root}/${encodeURIComponent(options.model)}/${encodeURIComponent(options.operation)}`,
    {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.input),
    },
  );
  const value: unknown = await response.json();
  if (!response.ok) {
    const protocolError = parseError(value);
    throw new StandaloneDatabaseError(
      protocolError?.code ?? "request-failed",
      protocolError?.message ??
        `Database request failed with status ${response.status}.`,
      response.status,
    );
  }
  if (!isRecord(value) || !("data" in value)) {
    throw new StandaloneDatabaseError(
      "invalid-response",
      "Database response must contain data.",
      response.status,
    );
  }
  return value.data;
};
