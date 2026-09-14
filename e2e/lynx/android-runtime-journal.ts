import crypto from "node:crypto";

import { LYNX_RUNTIME_EVENT_LIMITS } from "../../packages/lynx/src/types.ts";

const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JOURNAL_BYTES = LYNX_RUNTIME_EVENT_LIMITS.journalUtf8Bytes;
const MAX_EVENT_NAME_BYTES = LYNX_RUNTIME_EVENT_LIMITS.nameUtf8Bytes;
const MAX_EVENT_DETAILS_BYTES = LYNX_RUNTIME_EVENT_LIMITS.detailsUtf8Bytes;
const MAX_EVENTS = LYNX_RUNTIME_EVENT_LIMITS.retainedEvents;

type JsonRecord = Record<string, unknown>;

export type AndroidRuntimeJournalEvidence = {
  readonly actionResultResponse: unknown;
  readonly currentProcessId: string;
  readonly expectedLaunchGeneration: string | null;
  readonly expectedRuntimeScenarioMarker: string;
  readonly runtimeJournalUtf8: string;
  readonly screenStateResponse: unknown;
};

type ManagedIdentity = {
  readonly runtimeId: string;
  readonly processId: string;
  readonly generationId: string;
  readonly contextId: string;
  readonly attemptId: string;
  readonly pageAttemptId: string | null;
  readonly transitionId: string | null;
  readonly bundleId: string;
  readonly releaseId: string | null;
};

type RuntimeEvent = {
  readonly sequence: string;
  readonly name: string;
  readonly details: JsonRecord;
};

type RuntimeJournal = {
  readonly events: RuntimeEvent[];
  readonly nextSequence: string;
  readonly truncated: boolean;
};

type ScreenEvidence = {
  readonly events: RuntimeEvent[];
  readonly identity: ManagedIdentity;
  readonly latestSequence: string;
  readonly truncated: boolean;
};

export type AndroidRuntimeJournalRecoveryRejectionCode =
  | "journal.empty"
  | "journal.byte-limit"
  | "journal.invalid-json"
  | "journal.not-object"
  | "journal.keys"
  | "journal.schema-version"
  | "journal.truncated-type"
  | "journal.next-sequence-format"
  | "journal.noncanonical-json"
  | "journal.events-invalid"
  | "journal.empty-next-sequence"
  | "journal.events-unavailable"
  | "journal.untruncated-first-sequence"
  | "journal.next-sequence-event-mismatch"
  | "screen.current-process-id"
  | "screen.expected-launch-generation"
  | "screen.expected-runtime-marker"
  | "screen.response-not-object"
  | "screen.action-not-object"
  | "screen.action-keys"
  | "screen.state-not-object"
  | "screen.launch-generation-mismatch"
  | "screen.runtime-marker-mismatch"
  | "screen.launch-status"
  | "screen.bundle-id"
  | "screen.release-id"
  | "screen.generation-events-type"
  | "screen.snapshot-invalid-json"
  | "screen.snapshot-not-object"
  | "screen.snapshot-keys"
  | "screen.snapshot-schema-version"
  | "screen.snapshot-truncated-type"
  | "screen.snapshot-events-invalid"
  | "screen.snapshot-empty-events"
  | "screen.snapshot-oldest-sequence"
  | "screen.snapshot-latest-sequence"
  | "screen.state-action-receipt"
  | "screen.wait-action-receipt"
  | "screen.confirmed-ready-identity"
  | "evidence.truncated-mismatch"
  | "evidence.next-sequence-mismatch"
  | "evidence.canonical-events-mismatch"
  | "ready.missing"
  | "order.fatal-before-ready"
  | "boundary.identity-invalid"
  | "boundary.identity-mismatch"
  | "order.evaluate-missing"
  | "order.started-missing"
  | "order.started-before-evaluate"
  | "diagnostic.missing"
  | "diagnostic.count"
  | "order.diagnostic-before-started"
  | "diagnostic.identity-invalid"
  | "diagnostic.identity-mismatch"
  | "diagnostic.field-mismatch"
  | "font.missing"
  | "font.identity-invalid"
  | "font.identity-mismatch"
  | "font.path-mismatch"
  | "font.sha256-invalid"
  | "order.fatal-boundary"
  | "order.generation-boundary-after-ready"
  | "post-ready.identity-invalid"
  | "post-ready.identity-mismatch"
  | "log.unmatched-engine-error";

export type AndroidRuntimeJournalRecoveryRejection = {
  readonly code: AndroidRuntimeJournalRecoveryRejectionCode;
  readonly field?: string;
  readonly sequence?: string;
};

export type AndroidRuntimeJournalRecoveryResult =
  | { readonly recovered: true }
  | {
      readonly recovered: false;
      readonly rejection: AndroidRuntimeJournalRecoveryRejection;
    };

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly rejection: AndroidRuntimeJournalRecoveryRejection;
    };

const accepted = <T>(value: T): ParseResult<T> => ({ ok: true, value });

const rejected = (
  code: AndroidRuntimeJournalRecoveryRejectionCode,
  detail: Omit<AndroidRuntimeJournalRecoveryRejection, "code"> = {},
): ParseResult<never> => ({ ok: false, rejection: { code, ...detail } });

const recoveryRejected = (
  code: AndroidRuntimeJournalRecoveryRejectionCode,
  detail: Omit<AndroidRuntimeJournalRecoveryRejection, "code"> = {},
): AndroidRuntimeJournalRecoveryResult => ({
  recovered: false,
  rejection: { code, ...detail },
});

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalJson(value: unknown): string | null {
  if (value === null) return "null";
  if (typeof value === "string") {
    return hasValidUnicode(value) ? JSON.stringify(value) : null;
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : null;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    return items.some((item) => item === null) ? null : `[${items.join(",")}]`;
  }
  const object = record(value);
  if (object === null) return null;
  const entries: string[] = [];
  for (const key of Object.keys(object).sort()) {
    const canonicalKey = canonicalJson(key);
    const canonicalValue = canonicalJson(object[key]);
    if (canonicalKey === null || canonicalValue === null) return null;
    entries.push(`${canonicalKey}:${canonicalValue}`);
  }
  return `{${entries.join(",")}}`;
}

function managedIdentity(details: JsonRecord): ManagedIdentity | null {
  const required = [
    "runtimeId",
    "processId",
    "generationId",
    "contextId",
    "attemptId",
    "bundleId",
  ] as const;
  if (
    required.some(
      (key) => typeof details[key] !== "string" || details[key].length === 0,
    ) ||
    !POSITIVE_DECIMAL.test(String(details.processId)) ||
    ["releaseId", "pageAttemptId", "transitionId"].some(
      (key) =>
        details[key] !== null &&
        (typeof details[key] !== "string" || details[key].length === 0),
    )
  ) {
    return null;
  }
  return {
    runtimeId: String(details.runtimeId),
    processId: String(details.processId),
    generationId: String(details.generationId),
    contextId: String(details.contextId),
    attemptId: String(details.attemptId),
    pageAttemptId:
      details.pageAttemptId === null ? null : String(details.pageAttemptId),
    transitionId:
      details.transitionId === null ? null : String(details.transitionId),
    bundleId: String(details.bundleId),
    releaseId: details.releaseId === null ? null : String(details.releaseId),
  };
}

function sameIdentity(left: ManagedIdentity, right: ManagedIdentity): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof ManagedIdentity] ===
      right[key as keyof ManagedIdentity],
  );
}

function identityMismatchField(
  left: ManagedIdentity,
  right: ManagedIdentity,
): string | null {
  for (const key of Object.keys(left) as Array<keyof ManagedIdentity>) {
    if (left[key] !== right[key]) return key;
  }
  return null;
}

function isCanonicalManagedPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") >
      LYNX_RUNTIME_EVENT_LIMITS.managedPathUtf8Bytes ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    /[\\%?#:]/.test(value)
  ) {
    return false;
  }
  return (
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function isValidEngineDiagnostic(details: JsonRecord): boolean {
  return (
    managedIdentity(details) !== null &&
    typeof details.fatal === "boolean" &&
    Number.isSafeInteger(details.code) &&
    Number.isSafeInteger(details.subcode) &&
    typeof details.type === "string" &&
    details.type.length > 0 &&
    isCanonicalManagedPath(details.path)
  );
}

function parseEvents(value: unknown): RuntimeEvent[] | null {
  if (!Array.isArray(value) || value.length > MAX_EVENTS) return null;
  const events: RuntimeEvent[] = [];
  let prior: bigint | null = null;
  for (const item of value) {
    const event = record(item);
    if (
      event === null ||
      !hasExactKeys(event, ["sequence", "name", "details"]) ||
      typeof event.sequence !== "string" ||
      !POSITIVE_DECIMAL.test(event.sequence) ||
      typeof event.name !== "string" ||
      event.name.length === 0 ||
      Buffer.byteLength(event.name, "utf8") > MAX_EVENT_NAME_BYTES
    ) {
      return null;
    }
    const details = record(event.details);
    const canonicalDetails = canonicalJson(details);
    const sequence = BigInt(event.sequence);
    if (
      details === null ||
      canonicalDetails === null ||
      Buffer.byteLength(canonicalDetails, "utf8") > MAX_EVENT_DETAILS_BYTES ||
      (prior !== null && sequence !== prior + 1n)
    ) {
      return null;
    }
    for (const key of [
      "runtimeId",
      "processId",
      "generationId",
      "bundleId",
      "releaseId",
      "contextId",
      "pageAttemptId",
      "transitionId",
    ]) {
      if (!Object.hasOwn(details, key)) return null;
    }
    if (
      typeof details.runtimeId !== "string" ||
      details.runtimeId.length === 0 ||
      typeof details.processId !== "string" ||
      !POSITIVE_DECIMAL.test(details.processId) ||
      typeof details.generationId !== "string" ||
      details.generationId.length === 0 ||
      typeof details.bundleId !== "string" ||
      details.bundleId.length === 0 ||
      ["releaseId", "contextId", "pageAttemptId", "transitionId"].some(
        (key) =>
          details[key] !== null &&
          (typeof details[key] !== "string" || details[key].length === 0),
      )
    ) {
      return null;
    }
    if (
      event.name === "engineDiagnostic" &&
      !isValidEngineDiagnostic(details)
    ) {
      return null;
    }
    events.push({
      sequence: event.sequence,
      name: event.name,
      details,
    });
    prior = sequence;
  }
  return events;
}

function parseJournal(source: string): ParseResult<RuntimeJournal> {
  const byteLength = Buffer.byteLength(source, "utf8");
  if (source.length === 0) return rejected("journal.empty");
  if (byteLength > MAX_JOURNAL_BYTES) {
    return rejected("journal.byte-limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return rejected("journal.invalid-json");
  }
  const journal = record(parsed);
  if (journal === null) return rejected("journal.not-object");
  if (
    !hasExactKeys(journal, [
      "events",
      "nextSequence",
      "schemaVersion",
      "truncated",
    ])
  ) {
    return rejected("journal.keys");
  }
  if (journal.schemaVersion !== 1) return rejected("journal.schema-version");
  if (typeof journal.truncated !== "boolean") {
    return rejected("journal.truncated-type");
  }
  if (
    typeof journal.nextSequence !== "string" ||
    !POSITIVE_DECIMAL.test(journal.nextSequence)
  ) {
    return rejected("journal.next-sequence-format");
  }
  if (canonicalJson(journal) !== source) {
    return rejected("journal.noncanonical-json");
  }
  const events = parseEvents(journal.events);
  if (events === null) return rejected("journal.events-invalid");
  if (events.length === 0) {
    return journal.nextSequence === "1"
      ? accepted({ events, nextSequence: "1", truncated: journal.truncated })
      : rejected("journal.empty-next-sequence");
  }
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined) {
    return rejected("journal.events-unavailable");
  }
  if (journal.truncated === false && first.sequence !== "1") {
    return rejected("journal.untruncated-first-sequence");
  }
  if (BigInt(journal.nextSequence) !== BigInt(last.sequence) + 1n) {
    return rejected("journal.next-sequence-event-mismatch");
  }
  return accepted({
    events,
    nextSequence: journal.nextSequence,
    truncated: journal.truncated,
  });
}

function parseScreenEvidence(
  evidence: AndroidRuntimeJournalEvidence,
): ParseResult<ScreenEvidence> {
  if (!POSITIVE_DECIMAL.test(evidence.currentProcessId)) {
    return rejected("screen.current-process-id");
  }
  if (
    typeof evidence.expectedLaunchGeneration !== "string" ||
    evidence.expectedLaunchGeneration.length === 0
  ) {
    return rejected("screen.expected-launch-generation");
  }
  if (evidence.expectedRuntimeScenarioMarker.length === 0) {
    return rejected("screen.expected-runtime-marker");
  }
  const response = record(evidence.screenStateResponse);
  const actionResult = record(evidence.actionResultResponse);
  const screenState = response && record(response.screenState);
  if (response === null) return rejected("screen.response-not-object");
  if (actionResult === null) return rejected("screen.action-not-object");
  if (!hasExactKeys(actionResult, ["updateActionResult"])) {
    return rejected("screen.action-keys");
  }
  if (screenState === null) return rejected("screen.state-not-object");
  if (response.launchGeneration !== evidence.expectedLaunchGeneration) {
    return rejected("screen.launch-generation-mismatch");
  }
  if (
    screenState.runtimeScenarioMarker !== evidence.expectedRuntimeScenarioMarker
  ) {
    return rejected("screen.runtime-marker-mismatch");
  }
  if (screenState.launchStatus !== "Current Launch Status: CONFIRMED") {
    return rejected("screen.launch-status");
  }
  if (
    typeof screenState.currentBundleId !== "string" ||
    screenState.currentBundleId.length === 0
  ) {
    return rejected("screen.bundle-id");
  }
  if (
    screenState.currentReleaseId !== null &&
    (typeof screenState.currentReleaseId !== "string" ||
      screenState.currentReleaseId.length === 0)
  ) {
    return rejected("screen.release-id");
  }
  if (typeof screenState.generationEvents !== "string") {
    return rejected("screen.generation-events-type");
  }
  let snapshotValue: unknown;
  try {
    snapshotValue = JSON.parse(screenState.generationEvents);
  } catch {
    return rejected("screen.snapshot-invalid-json");
  }
  const snapshot = record(snapshotValue);
  if (snapshot === null) return rejected("screen.snapshot-not-object");
  if (
    !hasExactKeys(snapshot, [
      "events",
      "latestSequence",
      "oldestSequence",
      "schemaVersion",
      "truncated",
    ])
  ) {
    return rejected("screen.snapshot-keys");
  }
  if (snapshot.schemaVersion !== 1) {
    return rejected("screen.snapshot-schema-version");
  }
  if (typeof snapshot.truncated !== "boolean") {
    return rejected("screen.snapshot-truncated-type");
  }
  const events = parseEvents(snapshot.events);
  if (events === null) return rejected("screen.snapshot-events-invalid");
  const first = events?.[0];
  const last = events?.at(-1);
  const latestSequence = last?.sequence;
  if (latestSequence === undefined) {
    return rejected("screen.snapshot-empty-events");
  }
  const expectedActionResult = `generation-events -> ${latestSequence}`;
  if (snapshot.oldestSequence !== (first?.sequence ?? null)) {
    return rejected("screen.snapshot-oldest-sequence");
  }
  if (snapshot.latestSequence !== latestSequence) {
    return rejected("screen.snapshot-latest-sequence");
  }
  if (screenState.updateActionResult !== expectedActionResult) {
    return rejected("screen.state-action-receipt");
  }
  if (actionResult.updateActionResult !== expectedActionResult) {
    return rejected("screen.wait-action-receipt");
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const identity = managedIdentity(event.details);
    const confirmation = record(event.details.confirmation);
    if (
      event.name === "jsReady" &&
      identity !== null &&
      identity.processId === evidence.currentProcessId &&
      identity.bundleId === screenState.currentBundleId &&
      identity.releaseId === screenState.currentReleaseId &&
      confirmation?.status === "CONFIRMED"
    ) {
      return accepted({
        events,
        identity,
        latestSequence,
        truncated: snapshot.truncated,
      });
    }
  }
  return rejected("screen.confirmed-ready-identity");
}

const generationBoundaries = new Set([
  "generationWillEvaluate",
  "generationStarted",
]);
const terminalBoundaries = new Set([
  "generationWillRetire",
  "generationRetired",
  "runtimeFailed",
  "generationFailed",
  "generationReconstructionFailed",
]);

function isFatalBoundary(event: RuntimeEvent): boolean {
  if (terminalBoundaries.has(event.name)) return true;
  return (
    event.name === "pageAttemptTerminal" &&
    event.details.terminal === "verified-fatal"
  );
}

export function evaluateFontDiagnosticRecoveryByAndroidJournal(
  relativePath: string,
  evidence: AndroidRuntimeJournalEvidence,
): AndroidRuntimeJournalRecoveryResult {
  const journalResult = parseJournal(evidence.runtimeJournalUtf8);
  if (!journalResult.ok) {
    return { recovered: false, rejection: journalResult.rejection };
  }
  const screenResult = parseScreenEvidence(evidence);
  if (!screenResult.ok) {
    return { recovered: false, rejection: screenResult.rejection };
  }
  const journal = journalResult.value;
  const screen = screenResult.value;
  if (journal.truncated !== screen.truncated) {
    return recoveryRejected("evidence.truncated-mismatch");
  }
  if (
    journal.nextSequence !== (BigInt(screen.latestSequence) + 1n).toString()
  ) {
    return recoveryRejected("evidence.next-sequence-mismatch");
  }
  if (canonicalJson(journal.events) !== canonicalJson(screen.events)) {
    return recoveryRejected("evidence.canonical-events-mismatch");
  }
  const journalEvents = journal.events;
  const readyIndex = journalEvents.findLastIndex((event) => {
    const identity = managedIdentity(event.details);
    return (
      event.name === "jsReady" &&
      identity !== null &&
      sameIdentity(identity, screen.identity) &&
      record(event.details.confirmation)?.status === "CONFIRMED"
    );
  });
  if (readyIndex < 0) return recoveryRejected("ready.missing");

  let evaluateIndex = -1;
  let startedIndex = -1;
  for (let index = readyIndex; index >= 0; index -= 1) {
    const event = journalEvents[index];
    const identity = managedIdentity(event.details);
    if (isFatalBoundary(event)) {
      return recoveryRejected("order.fatal-before-ready", {
        sequence: event.sequence,
      });
    }
    if (generationBoundaries.has(event.name)) {
      if (identity === null) {
        return recoveryRejected("boundary.identity-invalid", {
          sequence: event.sequence,
        });
      }
      const field = identityMismatchField(identity, screen.identity);
      if (field !== null) {
        return recoveryRejected("boundary.identity-mismatch", {
          field,
          sequence: event.sequence,
        });
      }
      if (event.name === "generationStarted" && startedIndex < 0) {
        startedIndex = index;
      }
      if (event.name === "generationWillEvaluate") {
        evaluateIndex = index;
        break;
      }
    }
  }
  if (evaluateIndex < 0) {
    return recoveryRejected("order.evaluate-missing");
  }
  if (startedIndex < 0) return recoveryRejected("order.started-missing");
  if (startedIndex <= evaluateIndex) {
    return recoveryRejected("order.started-before-evaluate");
  }

  const diagnosticIndexes = journalEvents.flatMap((event, index) =>
    index > evaluateIndex &&
    index < readyIndex &&
    event.name === "engineDiagnostic"
      ? [index]
      : [],
  );
  if (diagnosticIndexes.length !== 1) {
    return recoveryRejected(
      diagnosticIndexes.length === 0
        ? "diagnostic.missing"
        : "diagnostic.count",
    );
  }
  const diagnosticIndex = diagnosticIndexes[0];
  if (diagnosticIndex === undefined) {
    return recoveryRejected("diagnostic.missing");
  }
  const diagnostic = journalEvents[diagnosticIndex];
  const diagnosticIdentity = managedIdentity(diagnostic.details);
  if (diagnosticIndex <= startedIndex) {
    return recoveryRejected("order.diagnostic-before-started", {
      sequence: diagnostic.sequence,
    });
  }
  if (diagnosticIdentity === null) {
    return recoveryRejected("diagnostic.identity-invalid", {
      sequence: diagnostic.sequence,
    });
  }
  const diagnosticIdentityField = identityMismatchField(
    diagnosticIdentity,
    screen.identity,
  );
  if (diagnosticIdentityField !== null) {
    return recoveryRejected("diagnostic.identity-mismatch", {
      field: diagnosticIdentityField,
      sequence: diagnostic.sequence,
    });
  }
  for (const [field, expected] of [
    ["fatal", false],
    ["code", 302],
    ["subcode", 30201],
    ["type", "font"],
    ["path", relativePath],
  ] as const) {
    if (diagnostic.details[field] !== expected) {
      return recoveryRejected("diagnostic.field-mismatch", {
        field,
        sequence: diagnostic.sequence,
      });
    }
  }

  const fontIndexes = journalEvents.flatMap((event, index) => {
    if (index <= diagnosticIndex || index >= readyIndex) return [];
    return event.name === "fontLoaded" ? [index] : [];
  });
  if (fontIndexes.length === 0) return recoveryRejected("font.missing");
  let fontAccepted = false;
  let fontRejection: AndroidRuntimeJournalRecoveryRejection | null = null;
  for (const fontIndex of fontIndexes) {
    const font = journalEvents[fontIndex];
    const identity = managedIdentity(font.details);
    if (identity === null) {
      fontRejection ??= {
        code: "font.identity-invalid",
        sequence: font.sequence,
      };
      continue;
    }
    const field = identityMismatchField(identity, screen.identity);
    if (field !== null) {
      fontRejection ??= {
        code: "font.identity-mismatch",
        field,
        sequence: font.sequence,
      };
      continue;
    }
    if (font.details.path !== relativePath) {
      fontRejection ??= {
        code: "font.path-mismatch",
        sequence: font.sequence,
      };
      continue;
    }
    if (
      typeof font.details.sha256 !== "string" ||
      !SHA256.test(font.details.sha256)
    ) {
      fontRejection ??= {
        code: "font.sha256-invalid",
        sequence: font.sequence,
      };
      continue;
    }
    fontAccepted = true;
    break;
  }
  if (!fontAccepted) {
    return {
      recovered: false,
      rejection: fontRejection ?? { code: "font.missing" },
    };
  }

  for (
    let index = evaluateIndex + 1;
    index < journalEvents.length;
    index += 1
  ) {
    const event = journalEvents[index];
    const identity = managedIdentity(event.details);
    if (isFatalBoundary(event)) {
      return recoveryRejected("order.fatal-boundary", {
        sequence: event.sequence,
      });
    }
    if (generationBoundaries.has(event.name) && index > readyIndex) {
      return recoveryRejected("order.generation-boundary-after-ready", {
        sequence: event.sequence,
      });
    }
    if (generationBoundaries.has(event.name) && identity === null) {
      return recoveryRejected("boundary.identity-invalid", {
        sequence: event.sequence,
      });
    }
    if (generationBoundaries.has(event.name) && identity !== null) {
      const field = identityMismatchField(identity, screen.identity);
      if (field !== null) {
        return recoveryRejected("boundary.identity-mismatch", {
          field,
          sequence: event.sequence,
        });
      }
    }
    if (index > readyIndex && identity === null) {
      return recoveryRejected("post-ready.identity-invalid", {
        sequence: event.sequence,
      });
    }
    if (index > readyIndex && identity !== null) {
      const field = identityMismatchField(identity, screen.identity);
      if (field !== null) {
        return recoveryRejected("post-ready.identity-mismatch", {
          field,
          sequence: event.sequence,
        });
      }
    }
  }
  return { recovered: true };
}

export function isFontDiagnosticRecoveredByAndroidJournal(
  relativePath: string,
  evidence: AndroidRuntimeJournalEvidence,
): boolean {
  return evaluateFontDiagnosticRecoveryByAndroidJournal(relativePath, evidence)
    .recovered;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") return typeof value;
  if (/^[A-Za-z0-9._:-]{1,96}$/.test(value)) return value;
  return `sha256:${sha256(value)}`;
}

function summarizeKeys(value: unknown): string {
  const object = record(value);
  if (object === null)
    return `type=${Array.isArray(value) ? "array" : typeof value}`;
  const keys = Object.keys(object).sort();
  const shown = keys
    .slice(0, 24)
    .map((key) =>
      /^[A-Za-z0-9._:-]{1,64}$/.test(key)
        ? key
        : `sha256:${sha256(key).slice(0, 12)}`,
    );
  return `type=object keys=[${shown.join(",")}] keyCount=${keys.length}`;
}

function summarizeReceipt(value: unknown): string {
  if (typeof value !== "string") return `type=${typeof value}`;
  const match = value.match(/^generation-events -> ([1-9][0-9]*)$/);
  return match
    ? `generation-events:${match[1]}`
    : `unrecognized:sha256:${sha256(value)}`;
}

function summarizeEventCollection(value: unknown): string {
  const events = parseEvents(value);
  if (events === null) return "events=invalid";
  return `events=${events.length} first=${events[0]?.sequence ?? "none"} last=${events.at(-1)?.sequence ?? "none"}`;
}

function summarizeSnapshot(value: unknown): string {
  if (typeof value !== "string") return `type=${typeof value}`;
  const prefix = `bytes=${Buffer.byteLength(value, "utf8")} sha256=${sha256(value)}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return `${prefix} parse=invalid-json`;
  }
  const snapshot = record(parsed);
  if (snapshot === null) return `${prefix} parse=not-object`;
  return `${prefix} ${summarizeEventCollection(snapshot.events)} oldest=${safeScalar(snapshot.oldestSequence)} latest=${safeScalar(snapshot.latestSequence)} truncated=${safeScalar(snapshot.truncated)}`;
}

function summarizeJournal(value: string): string {
  const prefix = `bytes=${Buffer.byteLength(value, "utf8")} sha256=${sha256(value)}`;
  const parsed = parseJournal(value);
  if (!parsed.ok) return `${prefix} parse=${parsed.rejection.code}`;
  return `${prefix} events=${parsed.value.events.length} first=${parsed.value.events[0]?.sequence ?? "none"} last=${parsed.value.events.at(-1)?.sequence ?? "none"} next=${parsed.value.nextSequence} truncated=${parsed.value.truncated}`;
}

export function formatAndroidRuntimeJournalRecoveryDiagnostic(
  evidence: AndroidRuntimeJournalEvidence,
  result: AndroidRuntimeJournalRecoveryResult,
): string {
  const action = record(evidence.actionResultResponse);
  const response = record(evidence.screenStateResponse);
  const screen = response && record(response.screenState);
  const reason = result.recovered
    ? "recovered"
    : [
        result.rejection.code,
        result.rejection.field && `field=${result.rejection.field}`,
        result.rejection.sequence && `sequence=${result.rejection.sequence}`,
      ]
        .filter(Boolean)
        .join(" ");
  return [
    `reason=${reason}`,
    `expected={processId=${safeScalar(evidence.currentProcessId)} launchGeneration=${safeScalar(evidence.expectedLaunchGeneration)} runtimeMarker=${safeScalar(evidence.expectedRuntimeScenarioMarker)}}`,
    `action={${summarizeKeys(evidence.actionResultResponse)} receipt=${summarizeReceipt(action?.updateActionResult)}}`,
    `screen={${summarizeKeys(evidence.screenStateResponse)} launchGeneration=${safeScalar(response?.launchGeneration)} state={${summarizeKeys(screen)} runtimeMarker=${safeScalar(screen?.runtimeScenarioMarker)} launchStatus=${safeScalar(screen?.launchStatus)} bundleId=${safeScalar(screen?.currentBundleId)} releaseId=${safeScalar(screen?.currentReleaseId)} receipt=${summarizeReceipt(screen?.updateActionResult)} snapshot={${summarizeSnapshot(screen?.generationEvents)}}}}`,
    `journal={${summarizeJournal(evidence.runtimeJournalUtf8)}}`,
  ].join(" ");
}
