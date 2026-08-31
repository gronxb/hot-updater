import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import { readInsightsReportQuery } from "./insightsReportQuery";
import type { BundleEventRow } from "./types/databaseRows";
import type {
  InsightsMovementMetric,
  InsightsReportQuery,
} from "./types/insightsQueries";

const hour = 3_600_000;
const day = 24 * hour;

export type InsightsReportProjection =
  | {
      readonly kind: "movement";
      readonly metric: InsightsMovementMetric;
      readonly bundleId: string;
      readonly installId: string;
      readonly bucketStartMs: number;
      readonly cohort: string;
    }
  | {
      readonly kind: "installation";
      readonly event: BundleEventRow;
      /** Null denotes the all-time overview, which has no bucket membership. */
      readonly bucketStartMs: number | null;
    };

/** Finite report semantics shared by provider-owned, resumable workers. */
export const createInsightsReportProjection = (
  input: InsightsReportQuery,
  asOfMs: number,
) => {
  const { query } = readInsightsReportQuery({ query: input });
  if (!Number.isSafeInteger(asOfMs) || asOfMs < 0)
    throw new DatabasePluginInputError("invalid-query");
  const window = "window" in query ? query.window : "all";
  const bucketSizeMs = window === "24h" ? hour : day;
  const bucketCount = window === "24h" ? 24 : window === "7d" ? 7 : 30;
  const firstBucketMs =
    query.kind === "activeOverview"
      ? asOfMs - bucketCount * bucketSizeMs
      : window === "all"
        ? null
        : Math.floor(asOfMs / bucketSizeMs) * bucketSizeMs -
          (bucketCount - 1) * bucketSizeMs;
  const requestedBundles =
    query.kind === "bundleSummaries"
      ? new Set(query.bundleIds)
      : query.kind === "bundleDetail"
        ? new Set([query.bundleId])
        : null;

  return {
    bucketSizeMs,
    firstBucketMs,
    lastBucketMs:
      query.kind === "activeOverview"
        ? asOfMs - bucketSizeMs
        : Math.floor(asOfMs / bucketSizeMs) * bucketSizeMs,
    project(event: BundleEventRow): InsightsReportProjection | null {
      if (
        event.received_at_ms >= asOfMs ||
        (firstBucketMs !== null && event.received_at_ms < firstBucketMs)
      )
        return null;
      if (
        query.kind === "installationOverview" ||
        query.kind === "activeOverview"
      ) {
        // Identity is selected only after all source rows have been reduced to
        // latest per installation. Historical identity still counts in buckets.
        return {
          kind: "installation",
          event,
          bucketStartMs:
            query.kind === "installationOverview"
              ? null
              : firstBucketMs! +
                Math.floor(
                  (event.received_at_ms - firstBucketMs!) / bucketSizeMs,
                ) *
                  bucketSizeMs,
        };
      }
      if (event.type !== "UPDATE_APPLIED" && event.type !== "RECOVERED")
        return null;
      const bundleId =
        event.type === "UPDATE_APPLIED"
          ? event.to_bundle_id
          : event.from_bundle_id;
      if (!requestedBundles!.has(bundleId)) return null;
      return {
        kind: "movement",
        metric: event.type === "UPDATE_APPLIED" ? "installed" : "recovered",
        bundleId,
        installId: event.install_id,
        bucketStartMs:
          Math.floor(event.received_at_ms / bucketSizeMs) * bucketSizeMs,
        cohort: event.cohort,
      };
    },
  };
};
