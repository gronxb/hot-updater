import { DatabasePluginInputError } from "./databasePluginCrudValidation";
import { isChannelText, isRecord } from "./databasePluginCrudValidationFields";
import {
  validateBundleUpdateData,
  validateApiKeyUpdateData,
  validateReleaseUpdateData,
} from "./databasePluginCrudValidationMutations";
import { validateCreateData } from "./databasePluginCrudValidationRows";
import type { DatabaseCommit } from "./types/internal";

const hasOnlyKeys = (
  value: Record<PropertyKey, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

const validateWhere = (
  where: unknown,
  field: "bundleId" | "id",
  validateValue: (value: unknown) => boolean = (value) =>
    typeof value === "string",
): void => {
  if (
    !isRecord(where) ||
    !hasOnlyKeys(where, [field]) ||
    !validateValue(Reflect.get(where, field))
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
};

const validateDatabaseChange = (change: unknown): void => {
  if (!isRecord(change)) {
    throw new DatabasePluginInputError("invalid-data");
  }
  switch (change.model) {
    case "bundles":
      switch (change.operation) {
        case "insert":
          if (!hasOnlyKeys(change, ["model", "operation", "row"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateCreateData("bundles", change.row);
          return;
        case "update":
          if (!hasOnlyKeys(change, ["model", "operation", "where", "update"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          validateBundleUpdateData(change.update);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "bundlePatches":
      switch (change.operation) {
        case "insert":
          if (!hasOnlyKeys(change, ["model", "operation", "row"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateCreateData("bundle_patches", change.row);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "bundleId");
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "releases":
      switch (change.operation) {
        case "insert":
          if (!hasOnlyKeys(change, ["model", "operation", "row"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateCreateData("releases", change.row);
          return;
        case "update":
          if (!hasOnlyKeys(change, ["model", "operation", "where", "update"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          validateReleaseUpdateData(change.update);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "releaseCatalogs":
      if (
        change.operation !== "put" ||
        !hasOnlyKeys(change, ["model", "operation", "row"])
      ) {
        throw new DatabasePluginInputError("invalid-operation");
      }
      validateCreateData("release_catalogs", change.row);
      return;
    case "channels":
      switch (change.operation) {
        case "insert":
          if (
            !hasOnlyKeys(change, ["model", "operation", "row", "onConflict"]) ||
            change.onConflict !== "ignore"
          ) {
            throw new DatabasePluginInputError("invalid-operation");
          }
          validateCreateData("channels", change.row);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id", isChannelText);
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "apiKeys":
      switch (change.operation) {
        case "insert":
          if (
            !hasOnlyKeys(change, ["model", "operation", "row", "onConflict"]) ||
            change.onConflict !== "ignore"
          ) {
            throw new DatabasePluginInputError("invalid-operation");
          }
          validateCreateData("api_keys", change.row);
          return;
        case "update":
          if (!hasOnlyKeys(change, ["model", "operation", "where", "update"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          if (!isRecord(change.update)) {
            throw new DatabasePluginInputError("invalid-data");
          }
          if (!hasOnlyKeys(change.update, ["revokedAtMs"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateApiKeyUpdateData({
            revoked_at_ms: change.update.revokedAtMs,
          });
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    default:
      throw new DatabasePluginInputError("invalid-model");
  }
};

const validateDatabaseCommitExpectation = (expectation: unknown): void => {
  if (!isRecord(expectation)) {
    throw new DatabasePluginInputError("invalid-data");
  }
  if (expectation.model === "releases") {
    if (
      !hasOnlyKeys(expectation, ["model", "id", "revision"]) ||
      typeof expectation.id !== "string" ||
      !(
        expectation.revision === null ||
        (typeof expectation.revision === "number" &&
          Number.isSafeInteger(expectation.revision) &&
          expectation.revision >= 1)
      )
    ) {
      throw new DatabasePluginInputError("invalid-data");
    }
    return;
  }
  if (expectation.model === "releaseCatalogs") {
    if (
      !hasOnlyKeys(expectation, ["model", "scopeKey", "generation"]) ||
      typeof expectation.scopeKey !== "string" ||
      !(
        expectation.generation === null ||
        (typeof expectation.generation === "number" &&
          Number.isSafeInteger(expectation.generation) &&
          expectation.generation >= 1)
      )
    ) {
      throw new DatabasePluginInputError("invalid-data");
    }
    return;
  }
  throw new DatabasePluginInputError("invalid-model");
};

export function validateDatabaseCommit(
  input: unknown,
): asserts input is DatabaseCommit {
  if (
    !isRecord(input) ||
    !Array.isArray(input.changes) ||
    (Object.hasOwn(input, "expectations")
      ? !hasOnlyKeys(input, ["changes", "expectations"]) ||
        !Array.isArray(input.expectations)
      : !hasOnlyKeys(input, ["changes"]))
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
  input.changes.forEach(validateDatabaseChange);
  if (Array.isArray(input.expectations)) {
    input.expectations.forEach(validateDatabaseCommitExpectation);
  }
}
