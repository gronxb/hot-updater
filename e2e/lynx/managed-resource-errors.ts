import {
  type AndroidRuntimeJournalEvidence,
  isFontDiagnosticRecoveredByAndroidJournal,
} from "./android-runtime-journal.ts";

const ENGINE_ERROR_CODE = /\bengine-error\b[^\r\n]*?\bcode=(301|302)\b/;
const ENGINE_ERROR_DETAILS =
  /^engine-error fatal=(true|false) code=(301|302) message=(\{.*\})$/;
const MATRIX_EVENT_MARKER = "HOT_UPDATER_MATRIX_EVENT ";
const MANAGED_RESOURCE_PREFIX = "hot-updater:///";
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const THREADTIME_ENVELOPE =
  /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[ ]+(\d+)[ ]+\d+ I HotUpdaterLynx: (.*)$/;
const BRIEF_ENVELOPE = /^I\/HotUpdaterLynx\([ ]*(\d+)\): (.*)$/;
const ACTIVE_GENERATION_BOUNDARIES = new Set([
  "generationWillEvaluate",
  "generationStarted",
]);
const TERMINAL_GENERATION_BOUNDARIES = new Set([
  "generationWillRetire",
  "generationRetired",
]);
const GENERATION_BOUNDARIES = new Set([
  "generationWillEvaluate",
  "generationStarted",
  "generationWillRetire",
  "generationRetired",
]);

type LogRecord = {
  readonly index: number;
  readonly line: string;
  readonly envelope: {
    readonly processId: string;
    readonly payload: string;
  } | null;
};

type MatrixEvent = Record<string, unknown> & {
  readonly event: string;
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

function parseEnvelope(line: string): LogRecord["envelope"] {
  const match = line.match(THREADTIME_ENVELOPE) ?? line.match(BRIEF_ENVELOPE);
  return match ? { processId: match[1], payload: match[2] } : null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function managedRelativePath(source: unknown): string | null {
  if (
    typeof source !== "string" ||
    !source.startsWith(MANAGED_RESOURCE_PREFIX)
  ) {
    return null;
  }
  const relative = source.slice(MANAGED_RESOURCE_PREFIX.length);
  let parsed: URL;
  let decodedPath: string;
  try {
    parsed = new URL(source);
    decodedPath = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
  const hasForbiddenCharacter = Array.from(relative).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || character === ":";
  });
  if (
    parsed.protocol !== "hot-updater:" ||
    parsed.host !== "" ||
    decodedPath !== relative ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    source !== `${MANAGED_RESOURCE_PREFIX}${relative}` ||
    relative.trim().length === 0 ||
    new TextEncoder().encode(relative).length > 1024 ||
    /[\\%?#]/.test(relative) ||
    hasForbiddenCharacter ||
    relative.startsWith("/") ||
    relative.endsWith("/") ||
    relative
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    return null;
  }
  return relative;
}

function parseMatrixEvent(record: LogRecord): MatrixEvent | null {
  const match = record.envelope?.payload.match(
    /^HOT_UPDATER_MATRIX_EVENT (\{.*\})$/,
  );
  if (!match) return null;
  const event = parseJsonObject(match[1]);
  return event && typeof event.event === "string"
    ? (event as MatrixEvent)
    : null;
}

function managedIdentity(event: MatrixEvent): ManagedIdentity | null {
  const requiredStrings = [
    "runtimeId",
    "processId",
    "generationId",
    "contextId",
    "attemptId",
    "bundleId",
  ] as const;
  if (
    requiredStrings.some(
      (key) => typeof event[key] !== "string" || event[key].length === 0,
    ) ||
    !POSITIVE_DECIMAL.test(String(event.processId)) ||
    (event.releaseId !== null &&
      (typeof event.releaseId !== "string" || event.releaseId.length === 0))
  ) {
    return null;
  }
  return {
    runtimeId: String(event.runtimeId),
    processId: String(event.processId),
    generationId: String(event.generationId),
    contextId: String(event.contextId),
    attemptId: String(event.attemptId),
    bundleId: String(event.bundleId),
    releaseId: event.releaseId === null ? null : String(event.releaseId),
  };
}

function sameIdentity(left: ManagedIdentity, right: ManagedIdentity): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof ManagedIdentity] ===
      right[key as keyof ManagedIdentity],
  );
}

function precedingIdentity(
  records: readonly LogRecord[],
  engineError: LogRecord,
): ManagedIdentity | null {
  const processId = engineError.envelope?.processId;
  if (!processId) return null;
  let boundIdentity: ManagedIdentity | null = null;
  for (let index = engineError.index - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record.envelope?.processId !== processId ||
      !record.envelope.payload.startsWith(MATRIX_EVENT_MARKER)
    ) {
      continue;
    }
    const event = parseMatrixEvent(record);
    const identity = event && managedIdentity(event);
    if (
      event === null ||
      identity === null ||
      identity.processId !== processId ||
      (boundIdentity !== null && !sameIdentity(boundIdentity, identity))
    ) {
      return null;
    }
    boundIdentity = identity;
    if (GENERATION_BOUNDARIES.has(event.event)) {
      return ACTIVE_GENERATION_BOUNDARIES.has(event.event)
        ? boundIdentity
        : null;
    }
  }
  return null;
}

function stopsRecoveryAtBoundary(
  record: LogRecord,
  event: MatrixEvent | null,
  boundIdentity: ManagedIdentity,
): boolean {
  if (
    event === null ||
    record.envelope?.processId !== boundIdentity.processId ||
    !GENERATION_BOUNDARIES.has(event.event)
  ) {
    return false;
  }
  if (TERMINAL_GENERATION_BOUNDARIES.has(event.event)) return true;
  const identity = managedIdentity(event);
  return identity === null || !sameIdentity(boundIdentity, identity);
}

function isRecoveredFontDiagnostic(
  records: readonly LogRecord[],
  engineError: LogRecord,
  fatal: string,
  message: string,
  journalEvidence?: AndroidRuntimeJournalEvidence | null,
): boolean {
  if (fatal !== "false") return false;
  const details = parseJsonObject(message);
  if (
    details?.error_code !== 302 ||
    details.sub_code !== 30201 ||
    details.type !== "font"
  ) {
    return false;
  }
  const relativePath = managedRelativePath(details.src);
  if (relativePath === null) return false;
  if (journalEvidence === null) return false;
  if (journalEvidence !== undefined) {
    return (
      engineError.envelope?.processId === journalEvidence.currentProcessId &&
      isFontDiagnosticRecoveredByAndroidJournal(relativePath, journalEvidence)
    );
  }
  const boundIdentity = precedingIdentity(records, engineError);
  if (boundIdentity === null) return false;
  const laterRecords = records.slice(engineError.index + 1);
  if (
    laterRecords.some(
      (record) =>
        record.envelope?.processId === boundIdentity.processId &&
        record.envelope.payload.startsWith(MATRIX_EVENT_MARKER) &&
        parseMatrixEvent(record) === null,
    )
  ) {
    return false;
  }

  for (const fontRecord of laterRecords) {
    const fontEvent = parseMatrixEvent(fontRecord);
    if (stopsRecoveryAtBoundary(fontRecord, fontEvent, boundIdentity)) {
      return false;
    }
    const identity = fontEvent && managedIdentity(fontEvent);
    if (
      fontEvent?.event !== "fontLoaded" ||
      fontEvent.path !== relativePath ||
      typeof fontEvent.sha256 !== "string" ||
      !SHA256.test(fontEvent.sha256)
    ) {
      continue;
    }
    if (
      identity === null ||
      !sameIdentity(boundIdentity, identity) ||
      fontRecord.envelope?.processId !== identity.processId
    ) {
      continue;
    }
    for (const readyRecord of records.slice(fontRecord.index + 1)) {
      const readyEvent = parseMatrixEvent(readyRecord);
      if (stopsRecoveryAtBoundary(readyRecord, readyEvent, boundIdentity)) {
        return false;
      }
      const readyIdentity = readyEvent && managedIdentity(readyEvent);
      if (
        readyEvent?.event === "jsReady" &&
        readyIdentity !== null &&
        sameIdentity(identity, readyIdentity) &&
        readyEvent.confirmation !== null &&
        typeof readyEvent.confirmation === "object" &&
        (readyEvent.confirmation as Record<string, unknown>).status ===
          "CONFIRMED" &&
        readyRecord.envelope?.processId === identity.processId
      ) {
        return true;
      }
    }
  }
  return false;
}

export function hasRecoverableAndroidFontDiagnostic(
  logs: string,
  currentProcessId: string,
): boolean {
  return logs.split(/\r?\n/).some((line, index) => {
    const record: LogRecord = {
      index,
      line,
      envelope: parseEnvelope(line),
    };
    const detailsMatch = record.envelope?.payload.match(ENGINE_ERROR_DETAILS);
    if (
      record.envelope?.processId !== currentProcessId ||
      detailsMatch?.[1] !== "false" ||
      detailsMatch[2] !== "302" ||
      record.envelope?.payload.match(/\bengine-error\b/g)?.length !== 1
    ) {
      return false;
    }
    const details = parseJsonObject(detailsMatch[3]);
    return (
      details?.error_code === 302 &&
      details.sub_code === 30201 &&
      details.type === "font" &&
      managedRelativePath(details.src) !== null
    );
  });
}

export function findManagedResourceEngineErrorCodes(
  logs: string,
  journalEvidence?: AndroidRuntimeJournalEvidence | null,
): number[] {
  const records = logs.split(/\r?\n/).map((line, index) => ({
    index,
    line,
    envelope: parseEnvelope(line),
  }));
  const codes: number[] = [];
  for (const record of records) {
    const codeMatch = record.line.match(ENGINE_ERROR_CODE);
    if (!codeMatch) continue;
    const code = Number(codeMatch[1]);
    const detailsMatch = record.envelope?.payload.match(ENGINE_ERROR_DETAILS);
    if (
      code === 302 &&
      detailsMatch?.[2] === "302" &&
      record.envelope?.payload.match(/\bengine-error\b/g)?.length === 1 &&
      isRecoveredFontDiagnostic(
        records,
        record,
        detailsMatch[1],
        detailsMatch[3],
        journalEvidence,
      )
    ) {
      continue;
    }
    codes.push(code);
  }
  return codes;
}

export function assertNoManagedResourceEngineErrors(
  logs: string,
  journalEvidence?: AndroidRuntimeJournalEvidence | null,
): void {
  const codes = findManagedResourceEngineErrorCodes(logs, journalEvidence);
  if (codes.length > 0) {
    throw new Error(
      `Managed Lynx resources emitted engine errors: ${codes.join(", ")}`,
    );
  }
}
