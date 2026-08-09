import type {
  BundleEventPersistenceRow,
  BundleEventPersistenceRowBase,
} from "./persistence";

export class InvalidBundleEventPersistenceRowError extends Error {
  readonly name = "InvalidBundleEventPersistenceRowError";
}

const rowKeys = [
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
] as const;

function invalidRow(): never {
  throw new InvalidBundleEventPersistenceRowError();
}

function getProperty(row: object, key: string): unknown {
  return Reflect.get(row, key);
}

function requiredString(row: object, key: string): string {
  const value = getProperty(row, key);
  return typeof value === "string" && value.length > 0 ? value : invalidRow();
}

function nullableString(row: object, key: string): string | null {
  const value = getProperty(row, key);
  return value === null || (typeof value === "string" && value.length > 0)
    ? value
    : invalidRow();
}

function parseBase(row: object): BundleEventPersistenceRowBase {
  const receivedAtMs = getProperty(row, "received_at_ms");
  if (
    typeof receivedAtMs !== "number" ||
    !Number.isSafeInteger(receivedAtMs) ||
    receivedAtMs < 0
  ) {
    return invalidRow();
  }
  const platform = getProperty(row, "platform");
  if (platform !== "android" && platform !== "ios") return invalidRow();
  return {
    id: requiredString(row, "id"),
    install_id: requiredString(row, "install_id"),
    user_id: nullableString(row, "user_id"),
    username: nullableString(row, "username"),
    to_bundle_id: requiredString(row, "to_bundle_id"),
    platform,
    app_version: requiredString(row, "app_version"),
    channel: requiredString(row, "channel"),
    cohort: requiredString(row, "cohort"),
    fingerprint_hash: nullableString(row, "fingerprint_hash"),
    sdk_version: nullableString(row, "sdk_version"),
    received_at_ms: receivedAtMs,
  };
}

function hasExactKeys(row: object): boolean {
  const keys = Reflect.ownKeys(row);
  return (
    keys.length === rowKeys.length &&
    rowKeys.every((key) => Object.hasOwn(row, key))
  );
}

export function parseBundleEventPersistenceRow(
  input: unknown,
): BundleEventPersistenceRow {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !hasExactKeys(input)
  ) {
    return invalidRow();
  }
  const type = getProperty(input, "type");
  switch (type) {
    case "UPDATE_APPLIED":
    case "RECOVERED": {
      const updateStrategy = requiredString(input, "update_strategy");
      if (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion") {
        return invalidRow();
      }
      return {
        ...parseBase(input),
        type,
        from_bundle_id: requiredString(input, "from_bundle_id"),
        update_strategy: updateStrategy,
      };
    }
    case "UNCHANGED":
      if (
        getProperty(input, "from_bundle_id") !== null ||
        getProperty(input, "update_strategy") !== null
      ) {
        return invalidRow();
      }
      return {
        ...parseBase(input),
        type,
        from_bundle_id: null,
        update_strategy: null,
      };
    default:
      return invalidRow();
  }
}
