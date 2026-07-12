import { DatabaseConnectorErrorV2 } from "./errors";

export type BundleShapeV2 = {
  readonly allowed: readonly string[];
  readonly required: readonly string[];
  readonly label: string;
};

const invalidBundle = (message: string): never => {
  throw new DatabaseConnectorErrorV2("INVALID_CHANGE_SET", message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireBundleRecordV2 = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value)) {
    return invalidBundle(`${label} must be an object`);
  }
  return value;
};

export const requireBundleShapeV2 = (
  value: Record<string, unknown>,
  shape: BundleShapeV2,
): void => {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !shape.allowed.includes(key)) ||
    shape.required.some((key) => !Object.hasOwn(value, key))
  ) {
    invalidBundle(`${shape.label} has an invalid shape`);
  }
};

export const requireBundleStringV2 = (
  value: unknown,
  label: string,
): string => {
  if (typeof value !== "string") {
    return invalidBundle(`${label} must be a string`);
  }
  return value;
};

export const requireNonEmptyBundleStringV2 = (
  value: unknown,
  label: string,
): string => {
  const parsed = requireBundleStringV2(value, label);
  if (parsed.trim().length === 0) {
    return invalidBundle(`${label} must be a non-empty string`);
  }
  return parsed;
};

export const requireBundleBooleanV2 = (
  value: unknown,
  label: string,
): boolean => {
  if (typeof value !== "boolean") {
    return invalidBundle(`${label} must be a boolean`);
  }
  return value;
};

export const requireNullableBundleStringV2 = (
  value: unknown,
  label: string,
): string | null =>
  value === null ? null : requireBundleStringV2(value, label);

export const readOptionalBundleFieldV2 = (
  value: Record<string, unknown>,
  key: string,
): unknown => (Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined);

export const invalidBundleFieldV2 = (message: string): never =>
  invalidBundle(message);
