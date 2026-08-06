import type { BundleEventPersistenceRow } from "./persistence.js";
import {
  InvalidBundleEventPersistenceRowError,
  parseBundleEventPersistenceRow,
} from "./rowParser.js";

export const ANALYTICS_BLOB_DATA_PREFIX =
  "_hot-updater/analytics/events-v2.data/";

export interface AnalyticsBlobOperations {
  loadObject(key: string): Promise<unknown | null>;
  compareAndSwapObject(
    key: string,
    expected: unknown | null,
    value: unknown,
  ): Promise<boolean>;
}

export class AnalyticsBlobFormatError extends Error {
  readonly name = "AnalyticsBlobFormatError";
}

type AnalyticsBlobPointer = Readonly<{ dataKey: string }>;

type AnalyticsBlobData = Readonly<{
  events: readonly BundleEventPersistenceRow[];
}>;

type AnalyticsBlobCandidate = Readonly<{
  dataKey: string;
  value: AnalyticsBlobData;
}>;

const dataHashPattern = /^[a-f0-9]{64}$/;

function compareRows(
  left: BundleEventPersistenceRow,
  right: BundleEventPersistenceRow,
): number {
  const time = left.received_at_ms - right.received_at_ms;
  if (time !== 0) return time;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function record(input: unknown, source: string): object {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AnalyticsBlobFormatError(`${source} must be an object.`);
  }
  return input;
}

function property(input: object, key: string): unknown {
  return Reflect.get(input, key);
}

function hasExactKeys(input: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(input);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(input, key))
  );
}

function parseDataKey(input: object, source: string): string {
  const dataKey = property(input, "dataKey");
  if (
    typeof dataKey !== "string" ||
    !dataKey.startsWith(ANALYTICS_BLOB_DATA_PREFIX) ||
    !dataKey.endsWith(".json")
  ) {
    throw new AnalyticsBlobFormatError(`${source} has an invalid data key.`);
  }

  const hash = dataKey.slice(ANALYTICS_BLOB_DATA_PREFIX.length, -5);
  if (!dataHashPattern.test(hash)) {
    throw new AnalyticsBlobFormatError(`${source} has an invalid data key.`);
  }
  return dataKey;
}

export function parseManifest(input: unknown): AnalyticsBlobPointer {
  const manifest = record(input, "Analytics manifest");
  const schema = property(manifest, "schema");
  if (
    typeof schema === "number" &&
    Number.isSafeInteger(schema) &&
    schema > 2
  ) {
    throw new AnalyticsBlobFormatError(
      `Analytics schema ${schema} is newer than schema 2.`,
    );
  }
  if (!hasExactKeys(manifest, ["dataKey", "schema"]) || schema !== 2) {
    throw new AnalyticsBlobFormatError("Analytics manifest has schema drift.");
  }
  return { dataKey: parseDataKey(manifest, "Analytics manifest") };
}

export function parseAnalyticsBlobPointer(
  input: unknown,
): AnalyticsBlobPointer {
  const pointer = record(input, "Analytics pending pointer");
  if (!hasExactKeys(pointer, ["dataKey"])) {
    throw new AnalyticsBlobFormatError(
      "Analytics pending pointer has schema drift.",
    );
  }
  return { dataKey: parseDataKey(pointer, "Analytics pending pointer") };
}

function normalizedRows(
  input: readonly unknown[],
): readonly BundleEventPersistenceRow[] {
  const rows = input.map(parseBundleEventPersistenceRow).toSorted(compareRows);
  const ids = new Set(rows.map(({ id }) => id));
  if (ids.size !== rows.length) {
    throw new AnalyticsBlobFormatError(
      "Analytics data has duplicate event ids.",
    );
  }
  return rows;
}

export function parseAnalyticsBlob(
  input: unknown,
): readonly BundleEventPersistenceRow[] {
  const data = record(input, "Analytics data");
  if (!hasExactKeys(data, ["events"])) {
    throw new AnalyticsBlobFormatError("Analytics data has schema drift.");
  }
  const events = property(data, "events");
  if (!Array.isArray(events)) {
    throw new AnalyticsBlobFormatError("Analytics events must be an array.");
  }
  try {
    return normalizedRows(events);
  } catch (error) {
    if (error instanceof InvalidBundleEventPersistenceRowError) {
      throw new AnalyticsBlobFormatError("Analytics data row is invalid.", {
        cause: error,
      });
    }
    throw error;
  }
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function dataForRows(
  rows: readonly BundleEventPersistenceRow[],
): Promise<AnalyticsBlobCandidate> {
  const events = normalizedRows(rows);
  const value = { events };
  const hash = await digest(JSON.stringify(value));
  return {
    dataKey: `${ANALYTICS_BLOB_DATA_PREFIX}${hash}.json`,
    value,
  };
}

export async function stageAnalyticsBlobData(
  operations: AnalyticsBlobOperations,
  rows: readonly BundleEventPersistenceRow[],
): Promise<string> {
  const candidate = await dataForRows(rows);
  let stored = await operations.loadObject(candidate.dataKey);
  if (stored === null) {
    const created = await operations.compareAndSwapObject(
      candidate.dataKey,
      null,
      candidate.value,
    );
    if (created) return candidate.dataKey;
    stored = await operations.loadObject(candidate.dataKey);
  }
  if (
    stored === null ||
    JSON.stringify(parseAnalyticsBlob(stored)) !==
      JSON.stringify(normalizedRows(rows))
  ) {
    throw new AnalyticsBlobFormatError(
      "Analytics content address contains different data.",
    );
  }
  return candidate.dataKey;
}

export async function loadAnalyticsBlobByPointer(
  operations: AnalyticsBlobOperations,
  pointer: AnalyticsBlobPointer,
): Promise<readonly BundleEventPersistenceRow[]> {
  const stored = await operations.loadObject(pointer.dataKey);
  if (stored === null) {
    throw new AnalyticsBlobFormatError("Analytics data object is missing.");
  }
  const rows = parseAnalyticsBlob(stored);
  const expected = await dataForRows(rows);
  if (expected.dataKey !== pointer.dataKey) {
    throw new AnalyticsBlobFormatError("Analytics data address is invalid.");
  }
  return rows;
}
