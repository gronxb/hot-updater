import { DatabaseConnectorErrorV2 } from "./errors";

type ManifestRecord = Readonly<Record<string, unknown>>;

const isManifestRecord = (value: unknown): value is ManifestRecord =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export const failManifest = (label: string): never => {
  throw new DatabaseConnectorErrorV2(
    "INVALID_MANIFEST",
    `manifest ${label} is invalid`,
  );
};

export const parseExactRecord = (
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): ManifestRecord => {
  if (!isManifestRecord(value)) {
    return failManifest(label);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    return failManifest(label);
  }
  return value;
};

export const parseNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return failManifest(label);
  }
  return value;
};

const isAllowedLiteral = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T => allowed.some((candidate) => candidate === value);

export const parseLiteral = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T => {
  if (!isAllowedLiteral(value, allowed)) {
    return failManifest(label);
  }
  return value;
};
