import {
  DatabasePluginInputError,
  type DatabaseJsonObject,
  type Platform,
} from "@hot-updater/plugin-core";
import { isDatabaseJsonObject } from "@hot-updater/plugin-core/internal";

/** Ancillary report data; queryable identity and lifecycle fields stay on the row. */
export type DatabaseBundleEventMetadata = DatabaseJsonObject & {
  readonly username: string | null;
  readonly cohort: string;
  readonly update_strategy: "fingerprint" | "appVersion" | null;
  readonly fingerprint_hash: string | null;
  readonly sdk_version: string | null;
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
    | { readonly type: "UNCHANGED"; readonly from_bundle_id: null }
  );

export const isDatabaseBundleEventMetadata = (
  value: unknown,
): value is DatabaseBundleEventMetadata =>
  isDatabaseJsonObject(value) &&
  (value.username === null || typeof value.username === "string") &&
  typeof value.cohort === "string" &&
  (value.update_strategy === null ||
    value.update_strategy === "fingerprint" ||
    value.update_strategy === "appVersion") &&
  (value.fingerprint_hash === null ||
    typeof value.fingerprint_hash === "string") &&
  (value.sdk_version === null || typeof value.sdk_version === "string");

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
 * A movement names the bundle it left and how the device updates; an
 * unchanged report names neither.
 */
const hasEventInvariants = (row: Readonly<Record<string, unknown>>) =>
  ((row.type === "UPDATE_DOWNLOADED" ||
    row.type === "UPDATE_APPLIED" ||
    row.type === "RECOVERED") &&
    typeof row.from_bundle_id === "string" &&
    (updateStrategyOf(row) === "fingerprint" ||
      updateStrategyOf(row) === "appVersion")) ||
  (row.type === "UNCHANGED" &&
    row.from_bundle_id === null &&
    updateStrategyOf(row) === null);

/**
 * Throws unless `row` has exactly the bundle event fields, each of its type,
 * and the invariants of its event type: `invalid-field` for an unknown field,
 * `invalid-data` for anything else.
 */
export const validateBundleEventFields = (row: unknown): void => {
  if (!isRecord(row)) throw new DatabasePluginInputError("invalid-data");
  for (const field of Object.keys(row)) {
    if (!Object.hasOwn(BUNDLE_EVENT_FIELDS, field)) {
      throw new DatabasePluginInputError("invalid-field");
    }
  }
  for (const [field, valid] of Object.entries(BUNDLE_EVENT_FIELDS)) {
    if (!Object.hasOwn(row, field) || !valid(row[field])) {
      throw new DatabasePluginInputError("invalid-data");
    }
  }
  if (!hasEventInvariants(row)) {
    throw new DatabasePluginInputError("invalid-data");
  }
};
