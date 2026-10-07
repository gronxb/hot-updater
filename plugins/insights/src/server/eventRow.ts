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
};

export type DatabaseHttpResponse = DatabaseJsonObject & {
  readonly resource: "catalog" | "artifact";
  readonly path: string;
  readonly status: number;
  readonly body: string | null;
  readonly body_truncated: boolean;
  readonly received_at_ms: number;
};

/** What a kept UNCHANGED row changed against its installation's head. */
export type BundleEventChangeKind =
  | "first_seen"
  | "bundle"
  | "release"
  | "app_version"
  | "channel"
  | "native_build";

/**
 * An UNCHANGED report the server keeps: what it changed against its
 * installation's head, and the running values the head held before it. A
 * report from an installation without a head is `first_seen` alone, with no
 * previous values: the installation is new to this server, not necessarily
 * to its device.
 */
export type BundleEventChange = DatabaseJsonObject & {
  readonly kinds: BundleEventChangeKind[];
  readonly previous:
    | (DatabaseJsonObject & {
        readonly bundle_id: string;
        readonly release_id: string | null;
        readonly app_version: string;
        readonly channel: string;
        readonly min_bundle_id?: string;
      })
    | null;
};

/** Ancillary report data; queryable identity and lifecycle fields stay on the row. */
export type DatabaseBundleEventMetadata = DatabaseJsonObject & {
  readonly cohort: string;
  readonly update_strategy: "fingerprint" | "appVersion" | null;
  readonly fingerprint_hash: string | null;
  readonly sdk_version: string | null;
  /** The native build's built-in bundle ID, when the SDK reports it. */
  readonly min_bundle_id?: string;
  /** `UPDATE_FAILED`: what failed. */
  readonly failure?: BundleEventFailure;
  readonly http_response?: DatabaseHttpResponse;
  /** `UPDATE_DOWNLOADED`: how the bundle arrived. */
  readonly delivery?: "patch" | "manifest" | "archive" | "unknown";
  /** `UPDATE_DOWNLOADED`: a patch failed and the full files came instead. */
  readonly patch_fallback?: boolean;
  /** A kept `UNCHANGED` row: what it changed, which the server sets. */
  readonly change?: BundleEventChange;
  /**
   * A download or apply of a target its installation already ran, as when
   * a reload cut the first runtime's report short, or a download that
   * repeats the pending one: the server keeps it in history, but it moves
   * and counts nothing.
   */
  readonly late?: true;
  /**
   * A launch or crash of a bundle whose download report never arrived: the
   * server counted that download with it.
   */
  readonly implied_download?: true;
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

const CHANGE_KINDS: ReadonlySet<unknown> = new Set<BundleEventChangeKind>([
  "first_seen",
  "bundle",
  "release",
  "app_version",
  "channel",
  "native_build",
]);

const isBundleEventChange = (value: unknown): boolean =>
  isDatabaseJsonObject(value) &&
  Array.isArray(value.kinds) &&
  value.kinds.length > 0 &&
  value.kinds.every((kind) => CHANGE_KINDS.has(kind)) &&
  (value.previous === null ||
    (isDatabaseJsonObject(value.previous) &&
      typeof value.previous.bundle_id === "string" &&
      (value.previous.release_id === null ||
        typeof value.previous.release_id === "string") &&
      typeof value.previous.app_version === "string" &&
      typeof value.previous.channel === "string" &&
      isOptional(value.previous, "min_bundle_id", isString)));

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
  isOptional(value, "error_stack", isString);

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
  isOptional(value, "min_bundle_id", isString) &&
  isOptional(value, "failure", isDatabaseBundleEventFailure) &&
  isOptional(value, "http_response", isDatabaseHttpResponse) &&
  isOptional(value, "delivery", isString) &&
  isOptional(value, "patch_fallback", (flag) => typeof flag === "boolean") &&
  isOptional(value, "change", isBundleEventChange) &&
  isOptional(value, "late", (flag) => flag === true) &&
  isOptional(value, "implied_download", (flag) => flag === true);

export const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The built-in bundle a report says its installation runs: the running
 * bundle, which a download leaves at its source, when it is the native
 * build's built-in bundle, whatever Release selected it. Null for any other
 * bundle, and for a report without the build's built-in bundle ID.
 */
export const runningBuiltinBundleId = (row: {
  readonly type: string;
  readonly from_bundle_id: string | null;
  readonly to_bundle_id: string;
  readonly metadata: unknown;
}): string | null => {
  const running =
    row.type === "UPDATE_DOWNLOADED" ? row.from_bundle_id : row.to_bundle_id;
  const builtin = isRecord(row.metadata) ? row.metadata.min_bundle_id : null;
  return typeof builtin === "string" && running === builtin ? builtin : null;
};

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

const hasMetadata = (row: Readonly<Record<string, unknown>>, key: string) =>
  isRecord(row.metadata) && Object.hasOwn(row.metadata, key);

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
      (isRecord(row.metadata) && isRecord(row.metadata.failure))) &&
    // Only a kept UNCHANGED row says what changed; only a download or an
    // apply arrives late; only a launch or a crash implies a download.
    !hasMetadata(row, "change") &&
    (!hasMetadata(row, "late") ||
      row.type === "UPDATE_DOWNLOADED" ||
      row.type === "UPDATE_APPLIED") &&
    (!hasMetadata(row, "implied_download") ||
      row.type === "UPDATE_APPLIED" ||
      row.type === "RECOVERED")) ||
  (row.type === "UNCHANGED" &&
    !hasMetadata(row, "late") &&
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
