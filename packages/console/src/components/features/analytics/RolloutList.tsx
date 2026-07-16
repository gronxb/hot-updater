import { Progress } from "@/components/ui/progress";
import type { ConfiguredRollout } from "@/lib/analytics-overview";

export function RolloutList({
  rollouts,
}: {
  readonly rollouts: readonly ConfiguredRollout[];
}) {
  if (rollouts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No configured bundle rollouts are available.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-4">
      {rollouts.map((rollout) => (
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
  );
}
