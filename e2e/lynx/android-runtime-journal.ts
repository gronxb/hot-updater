const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_NAME_BYTES = 128;
const MAX_EVENT_DETAILS_BYTES = 64 * 1024;
const MAX_EVENTS = 256;

type JsonRecord = Record<string, unknown>;

export type AndroidRuntimeJournalEvidence = {
  readonly currentProcessId: string;
  readonly expectedLaunchGeneration: string | null;
  readonly runtimeJournalUtf8: string;
  readonly screenStateResponse: unknown;
};

type ManagedIdentity = {
  readonly runtimeId: string;
  readonly processId: string;
  readonly generationId: string;
  readonly contextId: string;
  readonly attemptId: string;
  readonly bundleId: string;
  readonly releaseId: string | null;
};

type RuntimeEvent = {
  readonly sequence: string;
  readonly name: string;
  readonly details: JsonRecord;
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
    (details.releaseId !== null &&
      (typeof details.releaseId !== "string" || details.releaseId.length === 0))
  ) {
    return null;
  }
  return {
    runtimeId: String(details.runtimeId),
    processId: String(details.processId),
    generationId: String(details.generationId),
    contextId: String(details.contextId),
    attemptId: String(details.attemptId),
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
    events.push({
      sequence: event.sequence,
      name: event.name,
      details,
    });
    prior = sequence;
  }
  return events;
}

function parseJournal(source: string): RuntimeEvent[] | null {
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
    return journal.nextSequence === "1" ? events : null;
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
  return events;
}

function parseScreenEvidence(evidence: AndroidRuntimeJournalEvidence): {
  readonly events: RuntimeEvent[];
  readonly identity: ManagedIdentity;
} | null {
  if (!POSITIVE_DECIMAL.test(evidence.currentProcessId)) return null;
  const response = record(evidence.screenStateResponse);
  const screenState = response && record(response.screenState);
  if (
    response === null ||
    screenState === null ||
    response.launchGeneration !== evidence.expectedLaunchGeneration ||
    typeof screenState.runtimeScenarioMarker !== "string" ||
    screenState.runtimeScenarioMarker.length === 0 ||
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
  if (
    events === null ||
    snapshot.oldestSequence !== (first?.sequence ?? null) ||
    snapshot.latestSequence !== (last?.sequence ?? null)
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
      return { events, identity };
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
  const journalEvents = parseJournal(evidence.runtimeJournalUtf8);
  const screen = parseScreenEvidence(evidence);
  if (
    journalEvents === null ||
    screen === null ||
    canonicalJson(journalEvents) !== canonicalJson(screen.events)
  ) {
    return false;
  }
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

  let startIndex = -1;
  for (let index = readyIndex; index >= 0; index -= 1) {
    const event = journalEvents[index];
    const identity = managedIdentity(event.details);
    if (isFatalBoundary(event)) return false;
    if (generationBoundaries.has(event.name)) {
      if (identity === null || !sameIdentity(identity, screen.identity)) {
        return false;
      }
      if (event.name === "generationWillEvaluate") {
        startIndex = index;
        break;
      }
    }
  }
  if (startIndex < 0) return false;

  const fontIndex = journalEvents.findIndex((event, index) => {
    if (index <= startIndex || index >= readyIndex) return false;
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

  for (let index = startIndex + 1; index < journalEvents.length; index += 1) {
    const event = journalEvents[index];
    const identity = managedIdentity(event.details);
    if (isFatalBoundary(event)) return false;
    if (
      generationBoundaries.has(event.name) &&
      (identity === null || !sameIdentity(identity, screen.identity))
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
