import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import {
  isRecord,
  modelValidators,
  validateField,
} from "./databasePluginCrudValidationFields";
import { validateResult } from "./databasePluginCrudValidationRows";
import type {
  DatabasePluginImplementation,
  DatabaseSelect,
  UpdateDatabaseInput,
} from "./types";

export const validateMutationWhere = (where: readonly unknown[]): void => {
  if (where.length === 0) {
    throw new DatabasePluginInputError("empty-mutation-where");
  }
};

export const validateUpdateWhere = (where: readonly unknown[]): void => {
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
  if (
    Reflect.get(update, "target_app_version") === null &&
    Reflect.get(update, "fingerprint_hash") === null
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
};

export const validateBundleTargetUpdate = async (
  implementation: DatabasePluginImplementation,
  input: UpdateDatabaseInput<"bundles", DatabaseSelect<"bundles"> | undefined>,
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
    model: "bundles",
    where: [{ field: "id", value: id }],
    select: ["target_app_version", "fingerprint_hash"],
  });
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
    throw new DatabasePluginInputError("invalid-data");
  }
};
