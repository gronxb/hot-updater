import type { BundleChangeSetV2 } from "./bundles";
import { parseBundleSnapshotV2 } from "./bundleValidation";
import { snapshotCanonicalDatabaseValueV1 } from "./canonicalIdentity";
import {
  addSetValueV2,
  createSetV2,
  hasSetValueV2,
} from "./collectionIntrinsics";
import { DatabaseConnectorErrorV2 } from "./errors";

const CHANGE_SET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const invalidChangeSet = (message: string, cause?: unknown): never => {
  throw new DatabaseConnectorErrorV2(
    "INVALID_CHANGE_SET",
    message,
    cause === undefined ? undefined : { cause },
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value)) {
    return invalidChangeSet(`${label} must be an object`);
  }
  return value;
};

const requireExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  const keys = Object.keys(value);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowed.includes(key))
  ) {
    invalidChangeSet(`${label} has an invalid shape`);
  }
};

const requireNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidChangeSet(`${label} must be a non-empty string`);
  }
  return value;
};

const requireArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    return invalidChangeSet(`${label} must be an array`);
  }
  return value;
};

const validatePrecondition = (value: unknown, allowAbsent: boolean): void => {
  const precondition = requireRecord(value, "change precondition");
  const state = Reflect.get(precondition, "state");
  if (state === "absent" && allowAbsent) {
    requireExactKeys(precondition, ["state"], "absent precondition");
    return;
  }
  if (state === "revision") {
    requireExactKeys(
      precondition,
      ["state", "revision"],
      "revision precondition",
    );
    requireNonEmptyString(
      Reflect.get(precondition, "revision"),
      "revision precondition",
    );
    return;
  }
  invalidChangeSet("change precondition has an invalid state");
};

const validateChange = (value: unknown): string => {
  const change = requireRecord(value, "bundle change");
  const type = Reflect.get(change, "type");
  if (type === "put") {
    requireExactKeys(change, ["type", "value", "precondition"], "put change");
    const bundle = parseBundleSnapshotV2(Reflect.get(change, "value"));
    const id = bundle.id;
    validatePrecondition(Reflect.get(change, "precondition"), true);
    return id;
  }
  if (type === "delete") {
    requireExactKeys(change, ["type", "id", "precondition"], "delete change");
    const id = requireNonEmptyString(Reflect.get(change, "id"), "bundle ID");
    validatePrecondition(Reflect.get(change, "precondition"), false);
    return id;
  }
  return invalidChangeSet("bundle change has an invalid type");
};

const validateCanonicalShape = (changeSet: BundleChangeSetV2): void => {
  const candidate = requireRecord(changeSet, "change set");
  requireExactKeys(candidate, ["id", "changes"], "change set");
  const id = Reflect.get(candidate, "id");
  if (typeof id !== "string" || !CHANGE_SET_ID_PATTERN.test(id)) {
    invalidChangeSet(
      "change set ID must be a canonical lowercase UUID v4 or v7",
    );
  }
  const changes = requireArray(Reflect.get(candidate, "changes"), "changes");
  if (changes.length === 0) {
    invalidChangeSet("change set must contain at least one change");
  }
  const bundleIds = changes.map(validateChange);
  const seen = createSetV2<string>();
  for (const bundleId of bundleIds) {
    if (hasSetValueV2(seen, bundleId)) {
      invalidChangeSet(
        "change set must contain one final change per bundle ID",
      );
    }
    addSetValueV2(seen, bundleId);
  }
};

export const snapshotDatabaseChangeSetV2 = (
  changeSet: BundleChangeSetV2,
): BundleChangeSetV2 => {
  let snapshot: BundleChangeSetV2;
  try {
    snapshot = snapshotCanonicalDatabaseValueV1(changeSet);
  } catch (error) {
    if (error instanceof Error) {
      return invalidChangeSet("change set cannot be inspected safely");
    }
    return invalidChangeSet("change set inspection threw a non-error value");
  }
  validateCanonicalShape(snapshot);
  return snapshot;
};
