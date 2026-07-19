import { DatabaseAdapterInputError } from "./databaseAdapterCrudValidationErrors";
import {
  isRecord,
  modelValidators,
  validateField,
} from "./databaseAdapterCrudValidationFields";
import { validateResult } from "./databaseAdapterCrudValidationRows";
import type {
  DatabaseAdapterImplementation,
  DatabaseSelect,
  UpdateDatabaseInput,
} from "./types";

export const validateMutationWhere = (where: readonly unknown[]): void => {
  if (where.length === 0) {
    throw new DatabaseAdapterInputError("empty-mutation-where");
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
    throw new DatabaseAdapterInputError("invalid-update-selector");
  }
};

export const validateBundleUpdateData = (update: unknown): void => {
  if (!isRecord(update)) throw new DatabaseAdapterInputError("invalid-data");
  for (const [field, value] of Object.entries(update)) {
    if (field === "id") {
      throw new DatabaseAdapterInputError("invalid-data");
    }
    validateField("bundles", field);
    const validator = modelValidators.bundles[field];
    if (!validator || !validator(value)) {
      throw new DatabaseAdapterInputError("invalid-data");
    }
  }
  if (
    Reflect.get(update, "target_app_version") === null &&
    Reflect.get(update, "fingerprint_hash") === null
  ) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
};

export const validateBundleTargetUpdate = async <TContext>(
  implementation: DatabaseAdapterImplementation<TContext>,
  input: UpdateDatabaseInput<"bundles", DatabaseSelect<"bundles"> | undefined>,
  context: TContext | undefined,
): Promise<void> => {
  if (
    !Object.hasOwn(input.update, "target_app_version") &&
    !Object.hasOwn(input.update, "fingerprint_hash")
  ) {
    return;
  }
  const id = input.where[0]?.value;
  if (typeof id !== "string") return;
  const current = await implementation.findOne(
    {
      model: "bundles",
      where: [{ field: "id", value: id }],
      select: ["target_app_version", "fingerprint_hash"],
    },
    context,
  );
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
    throw new DatabaseAdapterInputError("invalid-data");
  }
};
