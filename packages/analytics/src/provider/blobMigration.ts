import {
  ANALYTICS_BLOB_KEY,
  ANALYTICS_BLOB_PENDING_KEY,
  AnalyticsBlobFormatError,
  AnalyticsBlobWriteConflictError,
  loadActiveAnalyticsBlob,
  loadAnalyticsBlobByPointer,
  parseAnalyticsBlobPointer,
  stageAnalyticsBlobData,
  type AnalyticsBlobOperations,
} from "./blobPersistence.js";
import type { BundleEventPersistenceRow } from "./persistence.js";
import {
  InvalidBundleEventPersistenceRowError,
  parseBundleEventPersistenceRow,
} from "./rowParser.js";

export type AnalyticsBlobCoreHandle = {
  readonly rawRoot: unknown;
  readonly snapshot: unknown;
};

export interface AnalyticsBlobMigrationOperations extends AnalyticsBlobOperations {
  /** Loads the resolved active Core snapshot, never an unresolved revision pointer. */
  loadActiveCoreBlob(): Promise<AnalyticsBlobCoreHandle | null>;
  /** Applies Core's exact row, relation, and revision compatibility checks. */
  assertCoreBlobCompatible(value: unknown): Promise<void>;
  /** Idempotently preserves the exact historical snapshot before publication. */
  archiveCoreBlob(value: AnalyticsBlobCoreHandle): Promise<void>;
  /** Stages a Core-compatible revision and CAS-publishes its active pointer. */
  publishCoreBlob(
    expected: AnalyticsBlobCoreHandle,
    value: unknown,
  ): Promise<boolean>;
}

type ParsedCoreBlob = {
  readonly compatible: unknown | null;
  readonly events: readonly BundleEventPersistenceRow[];
  readonly handle: AnalyticsBlobCoreHandle | null;
  readonly hasLegacyEvents: boolean;
};

type LoadedOptionalAnalytics = {
  readonly raw: unknown | null;
  readonly rows: readonly BundleEventPersistenceRow[];
};

type LoadedPendingAnalytics = LoadedOptionalAnalytics & {
  readonly dataKey: string | null;
};

const MAX_MIGRATION_ATTEMPTS = 16;

function record(input: unknown): object {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AnalyticsBlobFormatError("Core snapshot must be an object.");
  }
  return input;
}

function sameKeys(input: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(input);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(input, key))
  );
}

function parseEvents(
  input: readonly unknown[],
): readonly BundleEventPersistenceRow[] {
  try {
    return input.map(parseBundleEventPersistenceRow);
  } catch (error) {
    if (error instanceof InvalidBundleEventPersistenceRowError) {
      throw new AnalyticsBlobFormatError("Legacy Analytics row is invalid.", {
        cause: error,
      });
    }
    throw error;
  }
}

async function parseCoreBlob(
  operations: AnalyticsBlobMigrationOperations,
  handle: AnalyticsBlobCoreHandle | null,
): Promise<ParsedCoreBlob> {
  if (handle === null) {
    return {
      compatible: null,
      events: [],
      handle,
      hasLegacyEvents: false,
    };
  }
  const snapshot = record(handle.snapshot);
  const hasLegacyEvents = Object.hasOwn(snapshot, "bundle_events");
  const expectedKeys = hasLegacyEvents
    ? ["version", "bundles", "bundle_patches", "bundle_events"]
    : ["version", "bundles", "bundle_patches"];
  if (!sameKeys(snapshot, expectedKeys)) {
    throw new AnalyticsBlobFormatError(
      "Core snapshot contains an unknown or missing root field.",
    );
  }
  if (
    Reflect.get(snapshot, "version") !== 2 ||
    !Array.isArray(Reflect.get(snapshot, "bundles")) ||
    !Array.isArray(Reflect.get(snapshot, "bundle_patches"))
  ) {
    throw new AnalyticsBlobFormatError("Core snapshot is corrupt or future.");
  }
  const entries = Object.entries(snapshot).filter(
    ([key]) => key !== "bundle_events",
  );
  const compatible = Object.fromEntries(entries);
  await operations.assertCoreBlobCompatible(compatible);
  if (!hasLegacyEvents) {
    return { compatible, events: [], handle, hasLegacyEvents };
  }
  const legacyEvents = Reflect.get(snapshot, "bundle_events");
  if (!Array.isArray(legacyEvents)) {
    throw new AnalyticsBlobFormatError(
      "Legacy Analytics events must be an array.",
    );
  }
  return {
    compatible,
    events: parseEvents(legacyEvents),
    handle,
    hasLegacyEvents,
  };
}

function mergeRows(
  sources: readonly (readonly BundleEventPersistenceRow[])[],
): readonly BundleEventPersistenceRow[] {
  const merged = new Map<string, BundleEventPersistenceRow>();
  for (const rows of sources) {
    const sourceIds = new Set<string>();
    for (const row of rows) {
      if (sourceIds.has(row.id)) {
        throw new AnalyticsBlobFormatError(
          `Analytics source contains duplicate id '${row.id}'.`,
        );
      }
      sourceIds.add(row.id);
      const existing = merged.get(row.id);
      if (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(row)
      ) {
        throw new AnalyticsBlobFormatError(
          `Analytics event '${row.id}' has conflicting values.`,
        );
      }
      merged.set(row.id, row);
    }
  }
  return [...merged.values()];
}

async function loadOptionalActive(
  operations: AnalyticsBlobOperations,
): Promise<LoadedOptionalAnalytics> {
  const raw = await operations.loadObject(ANALYTICS_BLOB_KEY);
  if (raw === null) return { raw, rows: [] };
  const loaded = await loadActiveAnalyticsBlob(operations);
  return { raw: loaded.manifestRaw, rows: loaded.rows };
}

async function loadOptionalPending(
  operations: AnalyticsBlobOperations,
): Promise<LoadedPendingAnalytics> {
  const raw = await operations.loadObject(ANALYTICS_BLOB_PENDING_KEY);
  if (raw === null) return { dataKey: null, raw, rows: [] };
  const pointer = parseAnalyticsBlobPointer(raw);
  return {
    dataKey: pointer.dataKey,
    raw,
    rows: await loadAnalyticsBlobByPointer(operations, pointer),
  };
}

export async function migrateLegacyAnalyticsBlob(
  operations: AnalyticsBlobMigrationOperations,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_MIGRATION_ATTEMPTS; attempt += 1) {
    const core = await parseCoreBlob(
      operations,
      await operations.loadActiveCoreBlob(),
    );
    const active = await loadOptionalActive(operations);
    const pending = await loadOptionalPending(operations);
    const combined = mergeRows([active.rows, pending.rows, core.events]);

    if (
      !core.hasLegacyEvents &&
      active.raw !== null &&
      JSON.stringify(combined) === JSON.stringify(active.rows)
    ) {
      return;
    }

    const dataKey = await stageAnalyticsBlobData(operations, combined);
    const pendingPointer = { dataKey };
    if (pending.dataKey !== dataKey) {
      const pendingWritten = await operations.compareAndSwapObject(
        ANALYTICS_BLOB_PENDING_KEY,
        pending.raw,
        pendingPointer,
      );
      if (!pendingWritten) continue;
    }

    if (core.hasLegacyEvents) {
      if (core.handle === null || core.compatible === null) {
        throw new AnalyticsBlobFormatError("Legacy Core snapshot is missing.");
      }
      await operations.archiveCoreBlob(core.handle);
      const coreWritten = await operations.publishCoreBlob(
        core.handle,
        core.compatible,
      );
      if (!coreWritten) continue;
    }

    const manifestWritten = await operations.compareAndSwapObject(
      ANALYTICS_BLOB_KEY,
      active.raw,
      { dataKey, schema: 2 },
    );
    if (manifestWritten) return;
  }
  throw new AnalyticsBlobWriteConflictError(
    "Analytics migration state changed during every commit attempt.",
  );
}
