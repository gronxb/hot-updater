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

function parseJournal(source: string): RuntimeJournal | null {
  if (
    Buffer.byteLength(source, "utf8") > MAX_JOURNAL_BYTES ||
    source.length === 0
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const journal = record(parsed);
  if (
    journal === null ||
    !hasExactKeys(journal, [
      "events",
      "nextSequence",
      "schemaVersion",
      "truncated",
    ]) ||
    journal.schemaVersion !== 1 ||
    typeof journal.truncated !== "boolean" ||
    typeof journal.nextSequence !== "string" ||
    !POSITIVE_DECIMAL.test(journal.nextSequence) ||
    canonicalJson(journal) !== source
  ) {
    return null;
  }
  const events = parseEvents(journal.events);
  if (events === null) return null;
  if (events.length === 0) {
    return journal.nextSequence === "1"
      ? { events, nextSequence: "1", truncated: journal.truncated }
      : null;
  }
  const first = events[0];
  const last = events.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    (journal.truncated === false && first.sequence !== "1") ||
    BigInt(journal.nextSequence) !== BigInt(last.sequence) + 1n
  ) {
    return null;
  }
  return {
    events,
    nextSequence: journal.nextSequence,
    truncated: journal.truncated,
  };
}

function parseScreenEvidence(
  evidence: AndroidRuntimeJournalEvidence,
): ScreenEvidence | null {
  if (
    !POSITIVE_DECIMAL.test(evidence.currentProcessId) ||
    typeof evidence.expectedLaunchGeneration !== "string" ||
    evidence.expectedLaunchGeneration.length === 0 ||
    evidence.expectedRuntimeScenarioMarker.length === 0
  ) {
    return null;
  }
  const response = record(evidence.screenStateResponse);
  const actionResult = record(evidence.actionResultResponse);
  const screenState = response && record(response.screenState);
  if (
    response === null ||
    actionResult === null ||
    !hasExactKeys(actionResult, ["updateActionResult"]) ||
    screenState === null ||
    response.launchGeneration !== evidence.expectedLaunchGeneration ||
    screenState.runtimeScenarioMarker !==
      evidence.expectedRuntimeScenarioMarker ||
    screenState.launchStatus !== "Current Launch Status: CONFIRMED" ||
    typeof screenState.currentBundleId !== "string" ||
    screenState.currentBundleId.length === 0 ||
    (screenState.currentReleaseId !== null &&
      (typeof screenState.currentReleaseId !== "string" ||
        screenState.currentReleaseId.length === 0)) ||
    typeof screenState.generationEvents !== "string"
  ) {
    return null;
  }
  let snapshotValue: unknown;
  try {
    snapshotValue = JSON.parse(screenState.generationEvents);
  } catch {
    return null;
  }
  const snapshot = record(snapshotValue);
  if (
    snapshot === null ||
    !hasExactKeys(snapshot, [
      "events",
      "latestSequence",
      "oldestSequence",
      "schemaVersion",
      "truncated",
    ]) ||
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.truncated !== "boolean"
  ) {
    return null;
  }
  const events = parseEvents(snapshot.events);
  const first = events?.[0];
  const last = events?.at(-1);
  const latestSequence = last?.sequence;
  const expectedActionResult = `generation-events -> ${latestSequence}`;
  if (
    events === null ||
    latestSequence === undefined ||
    snapshot.oldestSequence !== (first?.sequence ?? null) ||
    snapshot.latestSequence !== latestSequence ||
    screenState.updateActionResult !== expectedActionResult ||
    actionResult.updateActionResult !== expectedActionResult
  ) {
    return null;
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
      return {
        events,
        identity,
        latestSequence,
        truncated: snapshot.truncated,
      };
    }
  }
  return null;
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

export function isFontDiagnosticRecoveredByAndroidJournal(
  relativePath: string,
  evidence: AndroidRuntimeJournalEvidence,
): boolean {
  const journal = parseJournal(evidence.runtimeJournalUtf8);
  const screen = parseScreenEvidence(evidence);
  if (
    journal === null ||
    screen === null ||
    journal.truncated !== screen.truncated ||
    journal.nextSequence !== (BigInt(screen.latestSequence) + 1n).toString() ||
    canonicalJson(journal.events) !== canonicalJson(screen.events)
  ) {
    return false;
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
  if (readyIndex < 0) return false;

  let evaluateIndex = -1;
  let startedIndex = -1;
  for (let index = readyIndex; index >= 0; index -= 1) {
    const event = journalEvents[index];
    const identity = managedIdentity(event.details);
    if (isFatalBoundary(event)) return false;
    if (generationBoundaries.has(event.name)) {
      if (identity === null || !sameIdentity(identity, screen.identity)) {
        return false;
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
  if (evaluateIndex < 0 || startedIndex <= evaluateIndex) return false;

  const diagnosticIndexes = journalEvents.flatMap((event, index) =>
    index > evaluateIndex &&
    index < readyIndex &&
    event.name === "engineDiagnostic"
      ? [index]
      : [],
  );
  if (diagnosticIndexes.length !== 1) return false;
  const diagnosticIndex = diagnosticIndexes[0];
  if (diagnosticIndex === undefined) return false;
  const diagnostic = journalEvents[diagnosticIndex];
  const diagnosticIdentity = managedIdentity(diagnostic.details);
  if (
    diagnosticIndex <= startedIndex ||
    diagnosticIdentity === null ||
    !sameIdentity(diagnosticIdentity, screen.identity) ||
    diagnostic.details.fatal !== false ||
    diagnostic.details.code !== 302 ||
    diagnostic.details.subcode !== 30201 ||
    diagnostic.details.type !== "font" ||
    diagnostic.details.path !== relativePath
  ) {
    return false;
  }

  const fontIndex = journalEvents.findIndex((event, index) => {
    if (index <= diagnosticIndex || index >= readyIndex) return false;
    const identity = managedIdentity(event.details);
    return (
      event.name === "fontLoaded" &&
      identity !== null &&
      sameIdentity(identity, screen.identity) &&
      event.details.path === relativePath &&
      typeof event.details.sha256 === "string" &&
      SHA256.test(event.details.sha256)
    );
  });
  if (fontIndex < 0) return false;

  for (
    let index = evaluateIndex + 1;
    index < journalEvents.length;
    index += 1
  ) {
    const event = journalEvents[index];
    const identity = managedIdentity(event.details);
    if (isFatalBoundary(event)) return false;
    if (
      generationBoundaries.has(event.name) &&
      (index > readyIndex ||
        identity === null ||
        !sameIdentity(identity, screen.identity))
    ) {
      return false;
    }
    if (
      index > readyIndex &&
      (identity === null || !sameIdentity(identity, screen.identity))
    ) {
      return false;
    }
  }
  return true;
}
