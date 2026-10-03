import {
  DatabaseAdapterInputError,
  type DatabaseJsonObject,
  isDatabaseJsonObject,
  type Platform,
} from "@hot-updater/plugin-core";

/** Where an update failed, and what failed; open sets, `unknown` for any other value. */
export type BundleEventFailureStage =
  | "check"
  | "download"
  | "install"
  | "unknown";
export type BundleEventFailureReason =
  | "network"
  | "http"
  | "invalid_response"
  | "hash_mismatch"
  | "signature"
  | "patch"
  | "extract"
  | "storage"
  | "unknown";

/** An `UPDATE_FAILED` report's failure, as stored. */
export type BundleEventFailure = DatabaseJsonObject & {
  readonly stage: BundleEventFailureStage;
  readonly reason: BundleEventFailureReason;
  /** What the client was fetching or writing. */
  readonly resource?:
    | "catalog"
    | "artifact"
    | "manifest"
    | "file"
    | "patch"
    | "archive"
    | "unknown";
  readonly http_status?: number;
  /** How the connection failed, when it did. */
  readonly transport?:
    | "timeout"
    | "dns"
    | "tls"
    | "connection"
    | "offline"
    | "cancelled"
    | "unknown";
  /** The storage origin's error code, such as `ExpiredToken`. */
  readonly origin_code?: string;
  readonly error_message?: string;
  readonly error_stack?: string;
  /** Android's `ApplicationExitInfo` reason for the process before this one. */
  readonly previous_process_exit?: string;
};

export type DatabaseHttpResponse = DatabaseJsonObject & {
  readonly resource: "catalog" | "artifact";
  readonly path: string;
  readonly status: number;
  readonly body: string | null;
  readonly body_truncated: boolean;
  readonly received_at_ms: number;
};

/** Ancillary report data; queryable identity and lifecycle fields stay on the row. */
export type DatabaseBundleEventMetadata = DatabaseJsonObject & {
  readonly cohort: string;
  readonly update_strategy: "fingerprint" | "appVersion" | null;
  readonly fingerprint_hash: string | null;
  readonly sdk_version: string | null;
  /** `UPDATE_FAILED`: what failed. */
  readonly failure?: BundleEventFailure;
  readonly http_response?: DatabaseHttpResponse;
  /** `UPDATE_DOWNLOADED`: how the bundle arrived. */
  readonly delivery?: "patch" | "manifest" | "archive" | "unknown";
  /** `UPDATE_DOWNLOADED`: a patch failed and the full files came instead. */
  readonly patch_fallback?: boolean;
  /** `RECOVERED`: Android's `ApplicationExitInfo` reason for the crashed process. */
  readonly previous_process_exit?: string;
};

export type BundleEventRowBase = {
  readonly id: string;
  readonly install_id: string;
  readonly user_id: string | null;
  readonly from_release_id: string | null;
  readonly to_release_id: string | null;
  readonly to_bundle_id: string;
  readonly platform: Platform;
  readonly app_version: string;
  readonly channel: string;
  readonly metadata: DatabaseBundleEventMetadata;
  readonly received_at_ms: number;
};

export type BundleEventRow = BundleEventRowBase &
  (
    | { readonly type: "UPDATE_DOWNLOADED"; readonly from_bundle_id: string }
    | {
        readonly type: "UPDATE_APPLIED" | "RECOVERED";
        readonly from_bundle_id: string;
      }
    /** An update that failed: `from` is the running bundle, `to` the target (for a check, the running bundle). */
    | { readonly type: "UPDATE_FAILED"; readonly from_bundle_id: string }
    | { readonly type: "UNCHANGED"; readonly from_bundle_id: null }
  );

const isOptional = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  valid: (field: unknown) => boolean,
) => !Object.hasOwn(value, key) || valid(value[key]);

const isString = (value: unknown) => typeof value === "string";

const isDatabaseHttpResponse = (value: unknown): boolean =>
  isDatabaseJsonObject(value) &&
  (value.resource === "catalog" || value.resource === "artifact") &&
  isString(value.path) &&
  Number.isSafeInteger(value.status) &&
  (value.body === null || isString(value.body)) &&
  typeof value.body_truncated === "boolean" &&
  Number.isSafeInteger(value.received_at_ms);

/** An `UPDATE_FAILED` report's stored failure: a stage and a reason, and what else the client knew. */
const isDatabaseBundleEventFailure = (value: unknown): boolean =>
  isDatabaseJsonObject(value) &&
  isString(value.stage) &&
  isString(value.reason) &&
  isOptional(value, "resource", isString) &&
  isOptional(value, "http_status", (status) => Number.isSafeInteger(status)) &&
  isOptional(value, "transport", isString) &&
  isOptional(value, "origin_code", isString) &&
  isOptional(value, "error_message", isString) &&
  isOptional(value, "error_stack", isString) &&
  isOptional(value, "previous_process_exit", isString);

export const isDatabaseBundleEventMetadata = (
  value: unknown,
): value is DatabaseBundleEventMetadata =>
  isDatabaseJsonObject(value) &&
  typeof value.cohort === "string" &&
  (value.update_strategy === null ||
    value.update_strategy === "fingerprint" ||
    value.update_strategy === "appVersion") &&
  (value.fingerprint_hash === null ||
    typeof value.fingerprint_hash === "string") &&
  (value.sdk_version === null || typeof value.sdk_version === "string") &&
  isOptional(value, "failure", isDatabaseBundleEventFailure) &&
  isOptional(value, "http_response", isDatabaseHttpResponse) &&
  isOptional(value, "delivery", isString) &&
  isOptional(value, "patch_fallback", (flag) => typeof flag === "boolean") &&
  isOptional(value, "previous_process_exit", isString);

export const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 255;

const isTextOrNull = (value: unknown) =>
  value === null || typeof value === "string";

/** Each bundle event field and what it holds. */
const BUNDLE_EVENT_FIELDS: Readonly<
  Record<string, (value: unknown) => boolean>
> = {
  id: (value) => typeof value === "string",
  type: (value) =>
    value === "UPDATE_DOWNLOADED" ||
    value === "UPDATE_APPLIED" ||
    value === "RECOVERED" ||
    value === "UPDATE_FAILED" ||
    value === "UNCHANGED",
  install_id: isIdentity,
  user_id: (value) => value === null || isIdentity(value),
  from_bundle_id: isTextOrNull,
  from_release_id: isTextOrNull,
  to_release_id: isTextOrNull,
  to_bundle_id: (value) => typeof value === "string",
  platform: (value) => value === "ios" || value === "android",
  app_version: (value) => typeof value === "string",
  channel: (value) => typeof value === "string",
  metadata: isDatabaseBundleEventMetadata,
  received_at_ms: (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
};

const updateStrategyOf = (row: Readonly<Record<string, unknown>>) =>
  isRecord(row.metadata) ? row.metadata.update_strategy : undefined;

/**
 * A movement, or a failed update, names the bundle it left and how the
 * device updates, and a failed update says what failed; an unchanged report
 * names neither.
 */
const hasEventInvariants = (row: Readonly<Record<string, unknown>>) =>
  ((row.type === "UPDATE_DOWNLOADED" ||
    row.type === "UPDATE_APPLIED" ||
    row.type === "RECOVERED" ||
    row.type === "UPDATE_FAILED") &&
    typeof row.from_bundle_id === "string" &&
    (updateStrategyOf(row) === "fingerprint" ||
      updateStrategyOf(row) === "appVersion") &&
    (row.type !== "UPDATE_FAILED" ||
      (isRecord(row.metadata) && isRecord(row.metadata.failure)))) ||
  (row.type === "UNCHANGED" &&
    row.from_bundle_id === null &&
    updateStrategyOf(row) === null);

/**
 * Throws unless `row` has exactly the bundle event fields, each of its type,
 * and the invariants of its event type: `invalid-field` for an unknown field,
 * `invalid-data` for anything else.
 */
export const validateBundleEventFields = (row: unknown): void => {
  if (!isRecord(row)) throw new DatabaseAdapterInputError("invalid-data");
  for (const field of Object.keys(row)) {
    if (!Object.hasOwn(BUNDLE_EVENT_FIELDS, field)) {
      throw new DatabaseAdapterInputError("invalid-field");
    }
  }
  for (const [field, valid] of Object.entries(BUNDLE_EVENT_FIELDS)) {
    if (!Object.hasOwn(row, field) || !valid(row[field])) {
      throw new DatabaseAdapterInputError("invalid-data");
    }
  }
  if (!hasEventInvariants(row)) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
};
