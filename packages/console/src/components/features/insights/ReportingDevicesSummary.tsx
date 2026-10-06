import { Skeleton } from "@/components/ui/skeleton";
import { usageMetrics, type UsageWindow } from "@/lib/insights-usage";

import { EstimatedCount } from "./EstimatedCount";
import { InsightsInfo } from "./InsightsInfo";

export function ReportingDevicesSummary({
  window,
  count,
  isPending,
  partial,
}: {
  readonly window: UsageWindow;
  readonly count: number | undefined;
  readonly isPending: boolean;
  readonly partial: boolean;
}) {
  const metric = usageMetrics[window];
  return (
    <div
      aria-label={`${metric.label} over ${metric.period}`}
      role="region"
      className="flex items-center gap-3"
    >
      {isPending ? (
        <Skeleton aria-label="Loading active users" className="h-9 w-12" />
      ) : (
        <p className="text-4xl font-semibold tracking-tight tabular-nums">
          {count === undefined ? (
            "—"
          ) : partial ? (
            `≥${count.toLocaleString()}`
          ) : (
            <EstimatedCount value={count} />
          )}
        </p>
      )}
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <span>{metric.label}</span>
        <InsightsInfo label={`How ${metric.label} is counted`}>
          Installations that reported in the last {metric.period}, estimated
          within about 3%. The chart shows them per {metric.interval}.
          {partial ? " Some history is missing, so this is a minimum." : ""}
        </InsightsInfo>
      </div>
    </div>
  );
}
