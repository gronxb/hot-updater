import type { BundleChangeSetV2, BundleChangeV2 } from "./bundles";
import { snapshotCanonicalDatabaseValueV1 } from "./canonicalIdentity";
import { DatabaseConnectorErrorV2 } from "./errors";
import type { CommitReceiptV2 } from "./receipts";

interface ExpectedReceiptIdentityV2 {
  readonly changeSetId: string;
  readonly scopeId: string;
  readonly canonicalPayloadHash: string;
}

const COMMON_KEYS = [
  "changeSetId",
  "scopeId",
  "canonicalPayloadHash",
  "outcome",
] as const;

const bundleIdOf = (change: BundleChangeV2): string => {
  switch (change.type) {
    case "put":
      return change.value.id;
    case "delete":
      return change.id;
  }
};

const protocolViolation = (message: string, cause?: unknown): never => {
  throw new DatabaseConnectorErrorV2(
    "CONNECTOR_PROTOCOL_VIOLATION",
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
    return protocolViolation(`${label} must be an object`);
  }
  return value;
};

const requireExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void => {
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key))
  ) {
    protocolViolation(`${label} has an invalid shape`);
  }
};

const requireRevision = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return protocolViolation(
      "commit receipt revisions must be non-empty strings",
    );
  }
  return value;
};

const validateIdentity = (
  receipt: Record<string, unknown>,
  expected: ExpectedReceiptIdentityV2,
): void => {
  if (
    Reflect.get(receipt, "changeSetId") !== expected.changeSetId ||
    Reflect.get(receipt, "scopeId") !== expected.scopeId ||
    Reflect.get(receipt, "canonicalPayloadHash") !==
      expected.canonicalPayloadHash
  ) {
    protocolViolation("commit receipt identity does not match the request");
  }
};

const parseRevisions = (
  value: unknown,
  changeSet: BundleChangeSetV2,
): Readonly<Record<string, string>> => {
  const revisions = requireRecord(value, "commit receipt revisions");
  const expectedIds = changeSet.changes.map(bundleIdOf).sort();
  const revisionIds = Object.keys(revisions).sort();
  if (
    expectedIds.length !== revisionIds.length ||
    expectedIds.some((id, index) => id !== revisionIds[index])
  ) {
    protocolViolation(
      "commit receipt revision keys do not match the change set",
    );
  }
  return Object.freeze(
    Object.fromEntries(
      expectedIds.map((id) => [
        id,
        requireRevision(Reflect.get(revisions, id)),
      ]),
    ),
  );
};

export const validateCommitReceiptV2 = (
  receipt: unknown,
  expected: ExpectedReceiptIdentityV2,
  changeSet: BundleChangeSetV2,
): CommitReceiptV2 => {
  let snapshot: unknown;
  try {
    snapshot = snapshotCanonicalDatabaseValueV1(receipt);
  } catch (error) {
    if (error instanceof Error) {
      return protocolViolation("commit receipt cannot be inspected safely");
    }
    return protocolViolation(
      "commit receipt inspection threw a non-error value",
    );
  }
  const candidate = requireRecord(snapshot, "commit receipt");
  validateIdentity(candidate, expected);
  const outcome = Reflect.get(candidate, "outcome");
  if (outcome === "committed" || outcome === "replayed") {
    requireExactKeys(
      candidate,
      [...COMMON_KEYS, "revisions"],
      `${outcome} receipt`,
    );
    return Object.freeze({
      ...expected,
      outcome,
      revisions: parseRevisions(Reflect.get(candidate, "revisions"), changeSet),
    });
  }
  if (outcome === "rejected") {
    requireExactKeys(candidate, [...COMMON_KEYS, "reason"], "rejected receipt");
    const reason = Reflect.get(candidate, "reason");
    if (reason !== "conflict" && reason !== "unsupported") {
      return protocolViolation("rejected receipt has an invalid reason");
    }
    return Object.freeze({ ...expected, outcome, reason });
  }
  if (outcome === "unknown") {
    requireExactKeys(
      candidate,
      [...COMMON_KEYS, "reason", "sessionState", "retry"],
      "unknown receipt",
    );
    if (
      Reflect.get(candidate, "reason") !== "transport-unknown" ||
      Reflect.get(candidate, "sessionState") !== "poisoned" ||
      Reflect.get(candidate, "retry") !== "identical-scope-id-and-payload-only"
    ) {
      return protocolViolation("unknown receipt has invalid recovery fields");
    }
    return Object.freeze({
      ...expected,
      outcome,
      reason: "transport-unknown",
      sessionState: "poisoned",
      retry: "identical-scope-id-and-payload-only",
    });
  }
  return protocolViolation("commit receipt has an invalid outcome");
};
