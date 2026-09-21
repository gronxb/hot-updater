import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

type JsonRecord = Record<string, unknown>;

const record = (value: unknown, label: string): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
};

const integer = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
};

const sequence = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a canonical decimal sequence`);
  }
  return value;
};

function summaryReceipt(value: unknown, label: string) {
  const receipt = record(value, label);
  if (
    typeof receipt.processId !== "string" ||
    !/^[1-9][0-9]*$/.test(receipt.processId)
  ) {
    throw new Error(`${label}.processId must be a canonical live process ID`);
  }
  if (receipt.schemaVersion !== 1 || typeof receipt.truncated !== "boolean") {
    throw new Error(`${label} has an invalid schema`);
  }
  const eventCount = integer(receipt.eventCount, `${label}.eventCount`);
  const byteLength = integer(receipt.byteLength, `${label}.byteLength`);
  const oldestSequence =
    receipt.oldestSequence === null
      ? null
      : sequence(receipt.oldestSequence, `${label}.oldestSequence`);
  const latestSequence =
    receipt.latestSequence === null
      ? null
      : sequence(receipt.latestSequence, `${label}.latestSequence`);
  if (
    (eventCount === 0) !==
    (oldestSequence === null || latestSequence === null)
  ) {
    throw new Error(`${label} sequence bounds do not match its event count`);
  }
  if (
    typeof receipt.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  ) {
    throw new Error(`${label}.sha256 must be a SHA-256 hash`);
  }
  if (receipt.canonicalUtf8 !== null) {
    if (typeof receipt.canonicalUtf8 !== "string") {
      throw new Error(`${label}.canonicalUtf8 must be a string or null`);
    }
    const bytes = Buffer.from(receipt.canonicalUtf8, "utf8");
    if (bytes.length !== byteLength) {
      throw new Error(`${label}.byteLength does not match canonicalUtf8`);
    }
    if (
      crypto.createHash("sha256").update(bytes).digest("hex") !== receipt.sha256
    ) {
      throw new Error(`${label}.sha256 does not match canonicalUtf8`);
    }
  }
  return {
    receipt,
    eventCount,
    oldestSequence,
    latestSequence,
    truncated: receipt.truncated,
    byteLength,
  };
}

function expectSummary(
  value: unknown,
  label: string,
  expected: {
    count: number;
    first: string | null;
    last: string | null;
    truncated: boolean;
  },
) {
  const parsed = summaryReceipt(value, label);
  if (
    parsed.eventCount !== expected.count ||
    parsed.oldestSequence !== expected.first ||
    parsed.latestSequence !== expected.last ||
    parsed.truncated !== expected.truncated
  ) {
    throw new Error(`${label} does not match the required retained suffix`);
  }
  return parsed;
}

export function validateMatrixRuntimeJournalDiagnostics(value: unknown): void {
  const evidence = record(value, "runtimeJournalFixtures");
  if (!Array.isArray(evidence.fixtures)) {
    throw new Error("runtimeJournalFixtures.fixtures must be an array");
  }
  const modes = [
    "retention-limit",
    "count-plus-one",
    "byte-plus-one",
    "corrupt-json",
    "noncanonical",
    "already-oversized",
  ] as const;
  if (
    JSON.stringify(
      evidence.fixtures.map(
        (value, index) => record(value, `fixtures[${index}]`).mode,
      ),
    ) !== JSON.stringify(modes)
  ) {
    throw new Error(
      "runtime journal fixture modes are incomplete or reordered",
    );
  }
  const repairBytes =
    '{"events":[],"nextSequence":"1","schemaVersion":1,"truncated":true}';
  for (const [index, mode] of modes.entries()) {
    const item = record(evidence.fixtures[index], `fixtures[${index}]`);
    const installed = expectSummary(
      item.installed,
      `${mode}.installed`,
      mode === "retention-limit"
        ? { count: 256, first: "1", last: "256", truncated: false }
        : mode === "count-plus-one"
          ? { count: 256, first: "2", last: "257", truncated: true }
          : mode === "byte-plus-one"
            ? { count: 255, first: "2", last: "256", truncated: true }
            : { count: 0, first: null, last: null, truncated: true },
    );
    if (
      (mode === "corrupt-json" ||
        mode === "noncanonical" ||
        mode === "already-oversized") &&
      installed.receipt.canonicalUtf8 !== repairBytes
    ) {
      throw new Error(`${mode} did not persist the canonical repair bytes`);
    }
    const prior =
      mode === "retention-limit"
        ? installed
        : expectSummary(
            item.afterAppend,
            `${mode}.afterAppend`,
            mode === "count-plus-one"
              ? { count: 256, first: "3", last: "258", truncated: true }
              : mode === "byte-plus-one"
                ? { count: 256, first: "2", last: "257", truncated: true }
                : { count: 1, first: "1", last: "1", truncated: true },
          );
    const reopened = summaryReceipt(item.afterReopen, `${mode}.afterReopen`);
    if (JSON.stringify(reopened.receipt) !== JSON.stringify(prior.receipt)) {
      throw new Error(`${mode} changed canonical journal bytes after reopen`);
    }
    if (reopened.byteLength > 16_777_216) {
      throw new Error(`${mode} retained an oversized journal`);
    }
  }
  summaryReceipt(evidence.restored, "runtimeJournalFixtures.restored");
}

export function validateRuntimeEventFieldBoundaryDiagnostics(
  value: unknown,
): void {
  const evidence = record(value, "runtimeEventFieldBoundaries");
  const result = record(evidence.result, "runtimeEventFieldBoundaries.result");
  for (const key of [
    "exactNameAccepted",
    "namePlusOneRejected",
    "exactDetailsAccepted",
    "detailsPlusOneRejected",
  ]) {
    if (result[key] !== true) throw new Error(`${key} must be true`);
  }
  if (result.acceptedSequenceCount !== 2) {
    throw new Error("event field exercise must accept exactly two events");
  }
  const before = result.beforeLatestSequence;
  const after = sequence(result.afterLatestSequence, "afterLatestSequence");
  if (
    before !== null &&
    BigInt(after) - BigInt(sequence(before, "beforeLatestSequence")) !== 2n
  ) {
    throw new Error("rejected event fields consumed a journal sequence");
  }
  const receipt = summaryReceipt(
    evidence.receipt,
    "runtimeEventFieldBoundaries.receipt",
  );
  if (receipt.latestSequence !== after) {
    throw new Error(
      "event boundary receipt does not include both accepted events",
    );
  }
}

function journalReceipt(value: unknown, label: string) {
  const receipt = record(value, label);
  const snapshot = record(receipt.snapshot, `${label}.snapshot`);
  if (snapshot.schemaVersion !== 1 || typeof snapshot.truncated !== "boolean") {
    throw new Error(`${label}.snapshot has an invalid schema`);
  }
  if (!Array.isArray(snapshot.events)) {
    throw new Error(`${label}.snapshot.events must be an array`);
  }
  const byteLength = integer(receipt.byteLength, `${label}.byteLength`);
  if (
    typeof receipt.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  ) {
    throw new Error(`${label}.sha256 must be a SHA-256 hash`);
  }
  if (receipt.canonicalUtf8 !== null) {
    if (typeof receipt.canonicalUtf8 !== "string") {
      throw new Error(`${label}.canonicalUtf8 must be a string or null`);
    }
    const bytes = Buffer.from(receipt.canonicalUtf8, "utf8");
    if (bytes.length !== byteLength) {
      throw new Error(`${label}.byteLength does not match canonicalUtf8`);
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== receipt.sha256) {
      throw new Error(`${label}.sha256 does not match canonicalUtf8`);
    }
  }
  return { byteLength, receipt, snapshot };
}

function expectJournal(
  value: unknown,
  label: string,
  expected: {
    count: number;
    first: string | null;
    last: string | null;
    truncated: boolean;
  },
) {
  const parsed = journalReceipt(value, label);
  if (
    parsed.snapshot.events.length !== expected.count ||
    parsed.snapshot.oldestSequence !== expected.first ||
    parsed.snapshot.latestSequence !== expected.last ||
    parsed.snapshot.truncated !== expected.truncated
  ) {
    throw new Error(`${label} does not match the required retained suffix`);
  }
  if (expected.count > 0) {
    const first = record(parsed.snapshot.events[0], `${label}.events[0]`);
    const last = record(
      parsed.snapshot.events[expected.count - 1],
      `${label}.events[last]`,
    );
    if (
      sequence(first.sequence, `${label}.events[0].sequence`) !==
        expected.first ||
      sequence(last.sequence, `${label}.events[last].sequence`) !==
        expected.last
    ) {
      throw new Error(`${label} event sequences do not match the snapshot`);
    }
  }
  return parsed;
}

export function validateRuntimeJournalDiagnostics(value: unknown): void {
  const evidence = record(value, "runtimeJournal");
  const fixtures = record(evidence.fixtures, "runtimeJournal.fixtures");
  expectJournal(fixtures["retention-limit"], "retention-limit", {
    count: 256,
    first: "1",
    last: "256",
    truncated: false,
  });
  expectJournal(fixtures["count-plus-one"], "count-plus-one", {
    count: 256,
    first: "2",
    last: "257",
    truncated: true,
  });
  const bytePlusOne = expectJournal(
    fixtures["byte-plus-one"],
    "byte-plus-one",
    { count: 255, first: "2", last: "256", truncated: true },
  );
  if (bytePlusOne.byteLength > 16_777_216) {
    throw new Error("byte-plus-one retained an oversized journal");
  }
  const repairBytes =
    '{"events":[],"nextSequence":"1","schemaVersion":1,"truncated":true}';
  for (const mode of ["corrupt-json", "noncanonical", "already-oversized"]) {
    const repaired = expectJournal(fixtures[mode], mode, {
      count: 0,
      first: null,
      last: null,
      truncated: true,
    });
    if (repaired.receipt.canonicalUtf8 !== repairBytes) {
      throw new Error(`${mode} did not persist the canonical repair bytes`);
    }
  }
  expectJournal(evidence.appended, "appended", {
    count: 256,
    first: "2",
    last: "257",
    truncated: true,
  });

  const fields = record(evidence.eventFields, "runtimeJournal.eventFields");
  for (const key of [
    "exactNameAccepted",
    "namePlusOneRejected",
    "exactDetailsAccepted",
    "detailsPlusOneRejected",
  ]) {
    if (fields[key] !== true) throw new Error(`${key} must be true`);
  }
  if (fields.acceptedSequenceCount !== 2) {
    throw new Error("event field exercise must accept exactly two events");
  }
  const before = fields.beforeLatestSequence;
  const after = sequence(fields.afterLatestSequence, "afterLatestSequence");
  if (
    before !== null &&
    BigInt(after) - BigInt(sequence(before, "before")) !== 2n
  ) {
    throw new Error("rejected event fields consumed a journal sequence");
  }
}

export function validateNavigationStackBoundary(value: unknown): string {
  const receipt = record(value, "navigationStackBoundary");
  if (receipt.rejectionCode !== "STACK_LIMIT_EXCEEDED") {
    throw new Error("stack depth 17 was not rejected by the native boundary");
  }
  const expectedDepths = Array.from({ length: 15 }, (_, index) => index + 2);
  if (
    JSON.stringify(receipt.acceptedDepths) !== JSON.stringify(expectedDepths)
  ) {
    throw new Error("native stack did not accept exactly depths 2 through 16");
  }
  if (
    !Array.isArray(receipt.acceptedContextIds) ||
    receipt.acceptedContextIds.length !== 15 ||
    new Set(receipt.acceptedContextIds).size !== 15
  ) {
    throw new Error("accepted stack pages need 15 distinct native contexts");
  }
  if (
    receipt.nativeDepthBeforeRejected !== 16 ||
    receipt.nativeDepthAfterRejected !== 16 ||
    !isDeepStrictEqual(receipt.beforeRejected, receipt.afterRejected)
  ) {
    throw new Error("rejected depth 17 mutated the logical or native stack");
  }
  const after = record(receipt.afterRejected, "afterRejected");
  if (
    !Array.isArray(after.orderedPageEntries) ||
    after.orderedPageEntries.length !== 16 ||
    !Array.isArray(after.orderedPageParameters) ||
    after.orderedPageParameters.length !== 16 ||
    after.topPageEntry !== "detail.lynx.bundle" ||
    typeof after.topContextId !== "string"
  ) {
    throw new Error(
      "depth boundary receipt lacks the exact stack and top page",
    );
  }
  return after.topContextId;
}
