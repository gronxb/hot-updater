import type {
  InsightsBundleSummary,
  InsightsModel,
  ReleaseRow,
} from "@hot-updater/plugin-core";

type BundleSummary = InsightsBundleSummary & { readonly bundleId: string };

export async function getReleaseActivity30d(
  insights: Pick<InsightsModel, "getReport">,
  releases: readonly ReleaseRow[],
): Promise<ReadonlyMap<string, BundleSummary>> {
  const bundleIds = [
    ...new Set(
      releases.flatMap(({ bundle_id }) =>
        bundle_id === null ? [] : [bundle_id],
      ),
    ),
  ].sort();
  if (bundleIds.length === 0) return new Map();

  try {
    const result = await insights.getReport({
      query: { kind: "bundleSummaries", bundleIds, window: "30d" },
    });
    if (
      (result.state !== "ready" && result.state !== "stale") ||
      result.data.kind !== "bundleSummaries"
    ) {
      return new Map();
    }
    return new Map(
      result.data.summary.map((summary) => [summary.bundleId, summary]),
    );
  } catch (error) {
    console.error("Error during Release list activity retrieval:", error);
    return new Map();
  }
}
