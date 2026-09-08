import { Skeleton } from "@/components/ui/skeleton";
import type { InsightsWindow } from "@/lib/insights-api";
import { usageMetrics } from "@/lib/insights-usage";

import { InsightsInfo } from "./InsightsInfo";

export function ReportingDevicesSummary({
  window,
  count,
  isPending,
  partial,
}: {
  readonly window: InsightsWindow;
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
          {count === undefined
            ? "—"
            : `${partial ? "≥" : ""}${count.toLocaleString()}`}
        </p>
      )}
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <span>{metric.label}</span>
        <InsightsInfo label={`How ${metric.label} is counted`}>
          Unique app installations that reported activity in the last{" "}
          {metric.period}, including no-change reports. Filtered by platform,
          channel, and app version. The chart counts unique reporting
          installations per {metric.interval}.
          {partial
            ? " Only part of the history is available; the total is a lower bound."
            : ""}
        </InsightsInfo>
      </div>
    </div>
  );
}
