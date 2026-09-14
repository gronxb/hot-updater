const ENGINE_ERROR_CODE = /\bengine-error\b[^\r\n]*\bcode=(301|302)\b/;
const ENGINE_ERROR_DETAILS =
  /\bengine-error\b\s+fatal=(true|false)\s+code=(301|302)\s+message=(.*)$/;
const MATRIX_EVENT_MARKER = "HOT_UPDATER_MATRIX_EVENT ";
const MANAGED_RESOURCE_PREFIX = "hot-updater:///";
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

type LogRecord = {
  readonly index: number;
  readonly line: string;
  readonly processId: string | null;
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

function logcatProcessId(line: string): string | null {
  return (
    line.match(/^\S+\s+\S+\s+(\d+)\s+\d+\s+[VDIWEF]\s+/)?.[1] ??
    line.match(/^[VDIWEF]\/[^\s(]+\(\s*(\d+)\):/)?.[1] ??
    null
  );
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
  if (
    relative.length === 0 ||
    relative.normalize("NFC") !== relative ||
    relative.includes("\0") ||
    /[\\%?#]/.test(relative) ||
    relative
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    return null;
  }
  return relative;
}

function parseMatrixEvent(record: LogRecord): MatrixEvent | null {
  const markerIndex = record.line.indexOf(MATRIX_EVENT_MARKER);
  if (markerIndex < 0) return null;
  const event = parseJsonObject(
    record.line.slice(markerIndex + MATRIX_EVENT_MARKER.length).trim(),
  );
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

function isRecoveredFontDiagnostic(
  records: readonly LogRecord[],
  engineError: LogRecord,
  fatal: string,
  message: string,
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
  const laterRecords = records.slice(engineError.index + 1);
  if (
    laterRecords.some(
      (record) =>
        record.line.includes(MATRIX_EVENT_MARKER) &&
        parseMatrixEvent(record) === null,
    )
  ) {
    return false;
  }

  for (const fontRecord of laterRecords) {
    const fontEvent = parseMatrixEvent(fontRecord);
    if (
      fontEvent?.event !== "fontLoaded" ||
      fontEvent.path !== relativePath ||
      typeof fontEvent.sha256 !== "string" ||
      !SHA256.test(fontEvent.sha256)
    ) {
      continue;
    }
    const identity = managedIdentity(fontEvent);
    if (
      identity === null ||
      (engineError.processId !== null &&
        engineError.processId !== identity.processId) ||
      (fontRecord.processId !== null &&
        fontRecord.processId !== identity.processId)
    ) {
      continue;
    }
    for (const readyRecord of records.slice(fontRecord.index + 1)) {
      const readyEvent = parseMatrixEvent(readyRecord);
      const readyIdentity = readyEvent && managedIdentity(readyEvent);
      if (
        readyEvent?.event === "jsReady" &&
        readyIdentity !== null &&
        sameIdentity(identity, readyIdentity) &&
        readyEvent.confirmation !== null &&
        typeof readyEvent.confirmation === "object" &&
        (readyEvent.confirmation as Record<string, unknown>).status ===
          "CONFIRMED" &&
        (readyRecord.processId === null ||
          readyRecord.processId === identity.processId)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function findManagedResourceEngineErrorCodes(logs: string): number[] {
  const records = logs.split(/\r?\n/).map((line, index) => ({
    index,
    line,
    processId: logcatProcessId(line),
  }));
  const codes: number[] = [];
  for (const record of records) {
    const codeMatch = record.line.match(ENGINE_ERROR_CODE);
    if (!codeMatch) continue;
    const code = Number(codeMatch[1]);
    const detailsMatch = record.line.match(ENGINE_ERROR_DETAILS);
    if (
      code === 302 &&
      detailsMatch?.[2] === "302" &&
      isRecoveredFontDiagnostic(
        records,
        record,
        detailsMatch[1],
        detailsMatch[3],
      )
    ) {
      continue;
    }
    codes.push(code);
  }
  return codes;
}

export function assertNoManagedResourceEngineErrors(logs: string): void {
  const codes = findManagedResourceEngineErrorCodes(logs);
  if (codes.length > 0) {
    throw new Error(
      `Managed Lynx resources emitted engine errors: ${codes.join(", ")}`,
    );
  }
}
