import {
  UniversalComponentDataNotReadyError,
  type UniversalComponentDataSource,
  UniversalComponentSchemaNotReadyError,
} from "@hot-updater/plugin-core";

import { analyticsComponentSchema } from "../componentSchema.js";
import { AnalyticsSchemaNotReadyError } from "./migration.js";
import type { AnalyticsPersistence } from "./persistence.js";
import { parseBundleEventPersistenceRow } from "./rowParser.js";

const translateReadinessError = (error: unknown): never => {
  if (error instanceof UniversalComponentDataNotReadyError) {
    throw new AnalyticsSchemaNotReadyError({
      componentVersion:
        error instanceof UniversalComponentSchemaNotReadyError
          ? error.actualVersion
          : null,
      fingerprint: null,
      legacyVersion: null,
    });
  }
  throw error;
};

export const createUniversalComponentAnalyticsPersistence = (
  source: UniversalComponentDataSource,
): AnalyticsPersistence => {
  if (source.schema !== analyticsComponentSchema) {
    throw new TypeError("Analytics requires its canonical component schema.");
  }
  return {
    async append(row) {
      try {
        await source.append({ row, table: "bundle_events" });
      } catch (error) {
        return translateReadinessError(error);
      }
    },
    async scan(input) {
      try {
        const rows = await source.orderedScan({
          accessPattern: "bundle_events_by_received_at",
          ...(input.after === undefined
            ? {}
            : {
                afterExclusive: [input.after.receivedAtMs, input.after.id],
              }),
          beforePrefixExclusive: [input.beforeReceivedAtMs],
          limit: input.limit,
        });
        return rows.map(parseBundleEventPersistenceRow);
      } catch (error) {
        return translateReadinessError(error);
      }
    },
  };
};
