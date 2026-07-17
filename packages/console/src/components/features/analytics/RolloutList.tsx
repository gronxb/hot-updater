import type { ActiveInstallationOverview } from "@hot-updater/plugin-core";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { ConfiguredRollout } from "@/lib/analytics-overview";

const ROLLOUT_PAGE_SIZE = 5;

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const partialRank = (percentage: number): number =>
  percentage > 0 && percentage < 100 ? 0 : 1;

export function RolloutList({
  latestReportedBundles,
  rollouts,
}: {
  readonly latestReportedBundles: ActiveInstallationOverview["bundles"];
  readonly rollouts: readonly ConfiguredRollout[];
}) {
  const [page, setPage] = useState(1);

  if (rollouts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No configured bundle rollouts are available.
      </p>
    );
  }

  const reportsByBundleId = new Map(
    latestReportedBundles.map(({ bundleId, installations }) => [
      bundleId,
      installations,
    ]),
  );
  const rankedRollouts = [...rollouts].sort(
    (left, right) =>
      (reportsByBundleId.get(right.bundleId) ?? 0) -
        (reportsByBundleId.get(left.bundleId) ?? 0) ||
      partialRank(left.configuredPercentage) -
        partialRank(right.configuredPercentage) ||
      right.configuredPercentage - left.configuredPercentage ||
      compareCodePoints(left.bundleId, right.bundleId),
  );
  const totalPages = Math.ceil(rankedRollouts.length / ROLLOUT_PAGE_SIZE);
  const currentPage = Math.min(page, totalPages);
  const rangeStart = (currentPage - 1) * ROLLOUT_PAGE_SIZE;
  const rangeEnd = Math.min(rangeStart + ROLLOUT_PAGE_SIZE, rollouts.length);
  const visibleRollouts = rankedRollouts.slice(rangeStart, rangeEnd);

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-4">
        {visibleRollouts.map((rollout) => {
          const reportedInstallations =
            reportsByBundleId.get(rollout.bundleId) ?? 0;

          return (
            <li
              className="flex flex-col gap-2 border-b pb-3 last:border-0 last:pb-0"
              key={rollout.bundleId}
            >
              <div className="flex min-w-0 items-start justify-between gap-3 text-xs">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <code className="truncate text-foreground">
                    {rollout.bundleId}
                  </code>
                  <span className="text-muted-foreground">
                    {rollout.bundle.platform} · {rollout.bundle.channel}
                  </span>
                </div>
                <span className="shrink-0 font-medium tabular-nums">
                  {rollout.configuredPercentage}% configured
                </span>
              </div>
              <Progress
                aria-label={`${rollout.bundleId} configured rollout ${rollout.configuredPercentage}%`}
                aria-valuetext={`${rollout.configuredPercentage}% configured`}
                value={rollout.configuredPercentage}
              />
              <span className="text-xs text-muted-foreground tabular-nums">
                {reportedInstallations.toLocaleString()} reported in range
              </span>
            </li>
          );
        })}
      </ol>

      {totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground tabular-nums">
            Showing {rangeStart + 1}–{rangeEnd} of{" "}
            {rollouts.length.toLocaleString()} configured rollouts
          </p>
          <div className="flex items-center gap-2">
            <Button
              aria-label="Previous configured rollouts page"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
              type="button"
              variant="outline"
            >
              Previous
            </Button>
            <Button
              aria-label="Next configured rollouts page"
              disabled={currentPage === totalPages}
              onClick={() => setPage(currentPage + 1)}
              type="button"
              variant="outline"
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
