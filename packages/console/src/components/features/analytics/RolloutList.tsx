import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { ConfiguredRollout } from "@/lib/analytics-overview";

const ROLLOUT_PAGE_SIZE = 5;

export function RolloutList({
  rollouts,
}: {
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

  const totalPages = Math.ceil(rollouts.length / ROLLOUT_PAGE_SIZE);
  const currentPage = Math.min(page, totalPages);
  const rangeStart = (currentPage - 1) * ROLLOUT_PAGE_SIZE;
  const rangeEnd = Math.min(rangeStart + ROLLOUT_PAGE_SIZE, rollouts.length);
  const visibleRollouts = rollouts.slice(rangeStart, rangeEnd);

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-4">
        {visibleRollouts.map((rollout) => (
          <li className="flex flex-col gap-2" key={rollout.bundleId}>
            <div className="flex min-w-0 items-start justify-between gap-3 text-xs">
              <div className="flex min-w-0 flex-col gap-0.5">
                <code className="truncate text-foreground">
                  {rollout.bundleId}
                </code>
                <span className="text-muted-foreground">
                  {rollout.bundle.platform} · {rollout.bundle.channel} ·{" "}
                  {rollout.trackedInstallations.toLocaleString()} tracked
                </span>
              </div>
              <span className="shrink-0 font-medium tabular-nums">
                {rollout.configuredPercentage}% configured
              </span>
            </div>
            <Progress
              aria-label={`${rollout.bundleId} configured rollout`}
              aria-valuetext={`${rollout.configuredPercentage}% configured`}
              value={rollout.configuredPercentage}
            />
          </li>
        ))}
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
