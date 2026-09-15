import type { RuntimeEvent, RuntimeEventsSnapshot } from "@hot-updater/lynx";

export type GenerationEvent = RuntimeEvent;
export type GenerationEventsSnapshot = RuntimeEventsSnapshot;

type GenerationEventsClient = {
  readonly getRuntimeEvents: () => Promise<RuntimeEventsSnapshot>;
};

const MAX_MANAGED_PATH_UTF8_BYTES = 1_024;

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const sequence = (value: unknown, label: string): string => {
  const result = string(value, label);
  if (!/^(?:0|[1-9][0-9]*)$/.test(result)) {
    throw new Error(`${label} must be a canonical decimal string`);
  }
  return result;
};

const nullableSequence = (value: unknown, label: string): string | null =>
  value === null ? null : sequence(value, label);

const nullableIdentity = (value: unknown, label: string): string | null =>
  value === null ? null : string(value, label);

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const validateManagedIdentity = (
  details: Record<string, unknown>,
  label: string,
): void => {
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
    if (!hasOwn(details, key)) {
      throw new Error(`${label}.${key} must be present`);
    }
  }
  string(details.runtimeId, `${label}.runtimeId`);
  const processId = string(details.processId, `${label}.processId`);
  if (!/^[1-9][0-9]*$/.test(processId)) {
    throw new Error(
      `${label}.processId must be a canonical positive decimal string`,
    );
  }
  string(details.generationId, `${label}.generationId`);
  string(details.bundleId, `${label}.bundleId`);
  nullableIdentity(details.releaseId, `${label}.releaseId`);
  nullableIdentity(details.contextId, `${label}.contextId`);
  nullableIdentity(details.pageAttemptId, `${label}.pageAttemptId`);
  nullableIdentity(details.transitionId, `${label}.transitionId`);
};

const pageAttemptTerminals = new Set([
  "admitted",
  "verified-fatal",
  "authorized-cancel",
  "process-interruption",
]);

const isCanonicalManagedPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  new TextEncoder().encode(value).length <= MAX_MANAGED_PATH_UTF8_BYTES &&
  !value.startsWith("/") &&
  !value.endsWith("/") &&
  !/[\\%?#:]/.test(value) &&
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  }) &&
  value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");

export function compareGenerationEventSequence(
  left: string,
  right: string,
): number {
  return left.length === right.length
    ? left < right
      ? -1
      : left > right
        ? 1
        : 0
    : left.length < right.length
      ? -1
      : 1;
}

export function validateGenerationEventsSnapshot(
  value: unknown,
  options: { readonly allowTruncated?: boolean } = {},
): GenerationEventsSnapshot {
  const snapshot = record(value, "generation events snapshot");
  if (snapshot.schemaVersion !== 1) {
    throw new Error("generation events snapshot schemaVersion must be 1");
  }
  const oldestSequence = nullableSequence(
    snapshot.oldestSequence,
    "generation events oldestSequence",
  );
  const latestSequence = nullableSequence(
    snapshot.latestSequence,
    "generation events latestSequence",
  );
  if (
    oldestSequence !== null &&
    latestSequence !== null &&
    compareGenerationEventSequence(oldestSequence, latestSequence) > 0
  ) {
    throw new Error("generation events sequence bounds are reversed");
  }
  if (typeof snapshot.truncated !== "boolean") {
    throw new Error("generation events truncated must be boolean");
  }
  if (snapshot.truncated && options.allowTruncated !== true) {
    throw new Error("generation events were truncated before collection");
  }
  if (!Array.isArray(snapshot.events)) {
    throw new Error("generation events must be an array");
  }
  let priorSequence: string | null = null;
  const events = snapshot.events.map((rawEvent, index) => {
    const event = record(rawEvent, `generation events[${index}]`);
    if (
      JSON.stringify(Object.keys(event).sort()) !==
      JSON.stringify(["details", "name", "sequence"])
    ) {
      throw new Error(
        `generation events[${index}] must contain exactly sequence, name, and details`,
      );
    }
    const eventSequence = sequence(
      event.sequence,
      `generation events[${index}].sequence`,
    );
    if (
      (priorSequence !== null &&
        compareGenerationEventSequence(eventSequence, priorSequence) <= 0) ||
      (latestSequence !== null &&
        compareGenerationEventSequence(eventSequence, latestSequence) > 0)
    ) {
      throw new Error("generation events must be strictly ordered");
    }
    priorSequence = eventSequence;
    const name = string(event.name, `generation events[${index}].name`);
    const details = record(
      event.details,
      `generation events[${index}].details`,
    );
    validateManagedIdentity(details, `generation events[${index}].details`);
    if (
      name === "engineDiagnostic" &&
      (typeof details.attemptId !== "string" ||
        details.attemptId.length === 0 ||
        typeof details.contextId !== "string" ||
        details.contextId.length === 0 ||
        typeof details.fatal !== "boolean" ||
        !Number.isSafeInteger(details.code) ||
        !Number.isSafeInteger(details.subcode) ||
        typeof details.type !== "string" ||
        details.type.length === 0 ||
        !isCanonicalManagedPath(details.path))
    ) {
      throw new Error(
        `generation events[${index}].details is an invalid engine diagnostic`,
      );
    }
    if (
      name === "pageAttemptTerminal" &&
      (typeof details.terminal !== "string" ||
        !pageAttemptTerminals.has(details.terminal))
    ) {
      throw new Error(
        `generation events[${index}].details.terminal must be admitted, verified-fatal, authorized-cancel, or process-interruption`,
      );
    }
    return {
      sequence: eventSequence,
      name,
      details,
    };
  });
  if (
    (events.length === 0 &&
      (oldestSequence !== null || latestSequence !== null)) ||
    (events.length > 0 &&
      (oldestSequence !== events[0]?.sequence ||
        latestSequence !== events.at(-1)?.sequence))
  ) {
    throw new Error("generation event bounds do not match the snapshot events");
  }
  return {
    schemaVersion: 1,
    oldestSequence,
    latestSequence,
    truncated: snapshot.truncated,
    events,
  };
}

export async function readGenerationEvents(
  client: GenerationEventsClient,
  options: { readonly allowTruncated?: boolean } = {},
): Promise<GenerationEventsSnapshot> {
  return validateGenerationEventsSnapshot(
    await client.getRuntimeEvents(),
    options,
  );
}
