import type { BundlePageQueryV2, BundleWhereV2 } from "./bundles";
import {
  canonicalizeDatabaseValueV1,
  snapshotCanonicalDatabaseValueV1,
} from "./canonicalIdentity";
import { DatabaseConnectorErrorV2 } from "./errors";
import type {
  InMemoryCursorQueryV2,
  InMemoryCursorRequestV2,
  InMemoryPageRequestV2,
} from "./inMemoryTypes";

const WHERE_KEYS = [
  "channel",
  "platform",
  "enabled",
  "id",
  "targetAppVersion",
  "targetAppVersionIn",
  "targetAppVersionNotNull",
  "fingerprintHash",
] as const;
const ID_KEYS = ["eq", "gt", "gte", "lt", "lte", "in"] as const;

const invalidQuery = (message: string, cause?: unknown): never => {
  throw new DatabaseConnectorErrorV2(
    "INVALID_CURSOR",
    message,
    cause === undefined ? undefined : { cause },
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    return invalidQuery(`${label} must be an object`);
  }
  return value;
};

const exactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalidQuery(`${label} has an invalid shape`);
  }
};

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return invalidQuery(`${label} must be a string`);
  }
  return value;
};

const stringArray = (value: unknown, label: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return invalidQuery(`${label} must be a string array`);
  }
  return [...value];
};

const parseIdFilter = (value: unknown): BundleWhereV2["id"] => {
  if (value === undefined) {
    return undefined;
  }
  const candidate = record(value, "bundle ID filter");
  exactKeys(candidate, ID_KEYS, "bundle ID filter");
  const parsed = {
    eq: optionalString(Reflect.get(candidate, "eq"), "ID eq"),
    gt: optionalString(Reflect.get(candidate, "gt"), "ID gt"),
    gte: optionalString(Reflect.get(candidate, "gte"), "ID gte"),
    lt: optionalString(Reflect.get(candidate, "lt"), "ID lt"),
    lte: optionalString(Reflect.get(candidate, "lte"), "ID lte"),
    in:
      Reflect.get(candidate, "in") === undefined
        ? undefined
        : stringArray(Reflect.get(candidate, "in"), "ID in"),
  };
  return Object.fromEntries(
    Object.entries(parsed).filter((entry) => entry[1] !== undefined),
  );
};

const parseWhere = (value: unknown): BundleWhereV2 | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const candidate = record(value, "bundle filter");
  exactKeys(candidate, WHERE_KEYS, "bundle filter");
  const channel = optionalString(Reflect.get(candidate, "channel"), "channel");
  const platform = Reflect.get(candidate, "platform");
  const enabled = Reflect.get(candidate, "enabled");
  const target = Reflect.get(candidate, "targetAppVersion");
  const targetNotNull = Reflect.get(candidate, "targetAppVersionNotNull");
  const fingerprint = Reflect.get(candidate, "fingerprintHash");
  if (platform !== undefined && platform !== "ios" && platform !== "android") {
    return invalidQuery("platform must be ios or android");
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return invalidQuery("enabled must be boolean");
  }
  if (target !== undefined && target !== null && typeof target !== "string") {
    return invalidQuery("target app version must be string or null");
  }
  if (targetNotNull !== undefined && typeof targetNotNull !== "boolean") {
    return invalidQuery("target app version non-null flag must be boolean");
  }
  if (
    fingerprint !== undefined &&
    fingerprint !== null &&
    typeof fingerprint !== "string"
  ) {
    return invalidQuery("fingerprint hash must be string or null");
  }
  const parsed = {
    channel,
    platform,
    enabled,
    id: parseIdFilter(Reflect.get(candidate, "id")),
    targetAppVersion: target,
    targetAppVersionIn:
      Reflect.get(candidate, "targetAppVersionIn") === undefined
        ? undefined
        : stringArray(
            Reflect.get(candidate, "targetAppVersionIn"),
            "target app version list",
          ),
    targetAppVersionNotNull: targetNotNull,
    fingerprintHash: fingerprint,
  };
  const entries = Object.entries(parsed).filter(
    (entry) => entry[1] !== undefined,
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

const parseCursor = (value: unknown): InMemoryCursorRequestV2 | null => {
  if (value === undefined) {
    return null;
  }
  const candidate = record(value, "cursor");
  const keys = Object.keys(candidate);
  if (keys.length !== 1 || (keys[0] !== "after" && keys[0] !== "before")) {
    return invalidQuery("cursor must select exactly one direction");
  }
  const direction = keys[0];
  const token = Reflect.get(candidate, direction);
  if (typeof token !== "string" || token.length === 0) {
    return invalidQuery("cursor token must be a non-empty string");
  }
  return { direction, token };
};

export const parseInMemoryPageQueryV2 = (
  value: BundlePageQueryV2,
): InMemoryPageRequestV2 => {
  let snapshot: BundlePageQueryV2;
  try {
    snapshot = snapshotCanonicalDatabaseValueV1(value);
  } catch (error) {
    if (error instanceof Error) {
      return invalidQuery("page query cannot be inspected safely");
    }
    return invalidQuery("page query inspection threw a non-error value");
  }
  const candidate = record(snapshot, "page query");
  exactKeys(candidate, ["where", "limit", "cursor", "orderBy"], "page query");
  const limit = Reflect.get(candidate, "limit");
  if (
    !Number.isInteger(limit) ||
    typeof limit !== "number" ||
    limit < 1 ||
    limit > 1000
  ) {
    return invalidQuery("page limit must be an integer from 1 through 1000");
  }
  const orderValue = Reflect.get(candidate, "orderBy");
  let direction: InMemoryCursorQueryV2["direction"] = "desc";
  if (orderValue !== undefined) {
    const order = record(orderValue, "page order");
    exactKeys(order, ["field", "direction"], "page order");
    if (Reflect.get(order, "field") !== "id") {
      return invalidQuery("page order field must be id");
    }
    const parsedDirection = Reflect.get(order, "direction");
    if (parsedDirection !== "asc" && parsedDirection !== "desc") {
      return invalidQuery("page order direction is invalid");
    }
    direction = parsedDirection;
  }
  const where = parseWhere(Reflect.get(candidate, "where"));
  const query: InMemoryCursorQueryV2 = {
    ...(where === undefined ? {} : { where }),
    limit,
    direction,
  };
  return {
    query,
    cursor: parseCursor(Reflect.get(candidate, "cursor")),
    identity: canonicalizeDatabaseValueV1(query),
  };
};
