import {
  AnalyticsBlobFormatError,
  loadAnalyticsBlobByPointer,
  parseManifest,
  stageAnalyticsBlobData,
} from "./blobFormat.js";
import type { AnalyticsBlobOperations } from "./blobFormat.js";
import { AnalyticsSchemaNotReadyError } from "./migration.js";
import type {
  AnalyticsPersistence,
  BundleEventPersistenceRow,
} from "./persistence.js";
import { parseBundleEventPersistenceRow } from "./rowParser.js";

export {
  ANALYTICS_BLOB_DATA_PREFIX,
  AnalyticsBlobFormatError,
  loadAnalyticsBlobByPointer,
  parseAnalyticsBlob,
  parseAnalyticsBlobPointer,
  stageAnalyticsBlobData,
} from "./blobFormat.js";
export type { AnalyticsBlobOperations } from "./blobFormat.js";

export const ANALYTICS_BLOB_KEY = "_hot-updater/analytics/events-v2.json";
export const ANALYTICS_BLOB_PENDING_KEY =
  "_hot-updater/analytics/events-v2.pending.json";

export class AnalyticsBlobWriteConflictError extends Error {
  readonly name = "AnalyticsBlobWriteConflictError";
}

type LoadedAnalyticsBlob = {
  manifestRaw: unknown;
  rows: readonly BundleEventPersistenceRow[];
};

const MAX_COMMIT_ATTEMPTS = 16;

async function loadRuntimeAnalyticsBlob(
  operations: AnalyticsBlobOperations,
): Promise<LoadedAnalyticsBlob> {
  try {
    return await loadActiveAnalyticsBlob(operations);
  } catch (error) {
    if (error instanceof AnalyticsBlobFormatError) {
      throw new AnalyticsSchemaNotReadyError({
        componentVersion: null,
        fingerprint: "analytics-blob-incompatible",
        legacyVersion: null,
      });
    }
    throw error;
  }
}

export async function loadActiveAnalyticsBlob(
  operations: AnalyticsBlobOperations,
): Promise<LoadedAnalyticsBlob> {
  const manifestRaw = await operations.loadObject(ANALYTICS_BLOB_KEY);
  if (manifestRaw === null) {
    throw new AnalyticsBlobFormatError("Analytics schema is not ready.");
  }
  const manifest = parseManifest(manifestRaw);
  const rows = await loadAnalyticsBlobByPointer(operations, manifest);
  return { manifestRaw, rows };
}

export function createBlobAnalyticsPersistence(
  operations: AnalyticsBlobOperations,
): AnalyticsPersistence {
  return {
    async append(input) {
      const row = parseBundleEventPersistenceRow(input);
      for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
        const current = await loadRuntimeAnalyticsBlob(operations);
        if (current.rows.some(({ id }) => id === row.id)) {
          throw new AnalyticsBlobWriteConflictError(
            `Analytics event '${row.id}' already exists.`,
          );
        }
        const dataKey = await stageAnalyticsBlobData(operations, [
          ...current.rows,
          row,
        ]);
        const written = await operations.compareAndSwapObject(
          ANALYTICS_BLOB_KEY,
          current.manifestRaw,
          { dataKey, schema: 2 },
        );
        if (written) return;
      }
      throw new AnalyticsBlobWriteConflictError(
        "Analytics manifest changed during every commit attempt.",
      );
    },
    async scan(input) {
      const { rows } = await loadRuntimeAnalyticsBlob(operations);
      return rows
        .filter(
          (row) =>
            row.received_at_ms < input.beforeReceivedAtMs &&
            (input.after === undefined ||
              row.received_at_ms > input.after.receivedAtMs ||
              (row.received_at_ms === input.after.receivedAtMs &&
                row.id > input.after.id)),
        )
        .slice(0, input.limit);
    },
  };
}
