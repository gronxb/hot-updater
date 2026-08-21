import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import {
  isRecord,
  modelValidators,
  validateField,
} from "./databasePluginCrudValidationFields";
import { validateResult } from "./databasePluginCrudValidationRows";
import type {
  DatabaseSelect,
  TransactionDatabasePluginImplementation,
  UpdateDatabaseInput,
} from "./types/internal";

export const validateMutationWhere = (where: readonly unknown[]): void => {
  if (where.length === 0) {
    throw new DatabasePluginInputError("empty-mutation-where");
  }
};

export const validateUpdateWhere = (
  model: "bundles" | "releases" | "release_catalogs" | "api_keys",
  where: readonly unknown[],
): void => {
  const selector = where[0];
  const primaryField = model === "release_catalogs" ? "scope_key" : "id";
  if (
    where.length !== 1 ||
    !isRecord(selector) ||
    selector.field !== primaryField ||
    (selector.operator !== undefined && selector.operator !== "eq") ||
    typeof selector.value !== "string" ||
    selector.connector !== undefined ||
    selector.mode !== undefined
  ) {
    throw new DatabasePluginInputError("invalid-update-selector");
  }
};

export const validateBundleUpdateData = (update: unknown): void => {
  if (!isRecord(update)) throw new DatabasePluginInputError("invalid-data");
  for (const [field, value] of Object.entries(update)) {
    if (field === "id") {
      throw new DatabasePluginInputError("invalid-data");
    }
    validateField("bundles", field);
    const validator = modelValidators.bundles[field];
    if (!validator || !validator(value)) {
      throw new DatabasePluginInputError("invalid-data");
    }
  }
};

export const validateApiKeyUpdateData = (update: unknown): void => {
  if (
    !isRecord(update) ||
    Reflect.ownKeys(update).length !== 1 ||
    !Object.hasOwn(update, "revoked_at_ms") ||
    !modelValidators.api_keys.revoked_at_ms(
      Reflect.get(update, "revoked_at_ms"),
    )
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
};

const RELEASE_MUTABLE_FIELDS = new Set([
  "revision",
  "scope_key",
  "target_app_version",
  "fingerprint_hash",
  "enabled",
  "should_force_update",
  "message",
  "rollout_cohort_count",
  "target_cohorts",
  "updated_at_ms",
]);

export const validateReleaseUpdateData = (update: unknown): void => {
  if (!isRecord(update) || Reflect.ownKeys(update).length === 0) {
    throw new DatabasePluginInputError("invalid-data");
  }
  for (const [field, value] of Object.entries(update)) {
    if (!RELEASE_MUTABLE_FIELDS.has(field)) {
      throw new DatabasePluginInputError("invalid-data");
    }
    const validator = modelValidators.releases[field];
    if (!validator || !validator(value)) {
      throw new DatabasePluginInputError("invalid-data");
    }
  }
};

export const validateReleaseCatalogUpdateData = (update: unknown): void => {
  if (!isRecord(update)) {
    throw new DatabasePluginInputError("invalid-data");
  }
  const expectedFields = Object.keys(modelValidators.release_catalogs).filter(
    (field) => field !== "scope_key",
  );
  if (
    Reflect.ownKeys(update).length !== expectedFields.length ||
    expectedFields.some((field) => !Object.hasOwn(update, field))
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
  for (const [field, value] of Object.entries(update)) {
    const validator = modelValidators.release_catalogs[field];
    if (!validator || !validator(value)) {
      throw new DatabasePluginInputError("invalid-data");
    }
  }
};

export const validateReleaseTargetUpdate = async (
  implementation: TransactionDatabasePluginImplementation,
  input: UpdateDatabaseInput<
    "releases",
    DatabaseSelect<"releases"> | undefined
  >,
): Promise<void> => {
  if (
    !Object.hasOwn(input.update, "target_app_version") &&
    !Object.hasOwn(input.update, "fingerprint_hash")
  ) {
    return;
  }
  const id = input.where[0]?.value;
  if (typeof id !== "string") return;
  const current = await implementation.findOne({
    model: "releases",
    where: [{ field: "id", value: id }],
    select: ["strategy", "target_app_version", "fingerprint_hash"],
  });
  if (current === null) return;
  validateResult("releases", current, [
    "strategy",
    "target_app_version",
    "fingerprint_hash",
  ]);
  const strategy = Reflect.get(current, "strategy");
  const targetAppVersion = Object.hasOwn(input.update, "target_app_version")
    ? input.update.target_app_version
    : Reflect.get(current, "target_app_version");
  const fingerprintHash = Object.hasOwn(input.update, "fingerprint_hash")
    ? input.update.fingerprint_hash
    : Reflect.get(current, "fingerprint_hash");
  if (
    !(
      (strategy === "APP_VERSION" &&
        typeof targetAppVersion === "string" &&
        fingerprintHash === null) ||
      (strategy === "FINGERPRINT" &&
        targetAppVersion === null &&
        typeof fingerprintHash === "string")
    )
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
};
