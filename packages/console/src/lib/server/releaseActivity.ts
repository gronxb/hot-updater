import type { ReleaseRow } from "@hot-updater/plugin-core";
import type {
  InsightsProvider,
  BundleEventSummaryByBundle,
} from "@hot-updater/server";

export async function getReleaseActivity30d(
  insights: Pick<InsightsProvider, "getBundleEventSummaries"> | null,
  releases: readonly ReleaseRow[],
): Promise<ReadonlyMap<string, BundleEventSummaryByBundle>> {
  const bundleIds = [
    ...new Set(
      releases.flatMap(({ bundle_id }) =>
        bundle_id === null ? [] : [bundle_id],
      ),
    ),
  ];
  if (insights === null || bundleIds.length === 0) return new Map();

  try {
    const summaries = await insights.getBundleEventSummaries(bundleIds, "30d");
    return new Map(summaries.map((summary) => [summary.bundleId, summary]));
  } catch (error) {
    console.error("Error during Release list activity retrieval:", error);
    return new Map();
  }
}
