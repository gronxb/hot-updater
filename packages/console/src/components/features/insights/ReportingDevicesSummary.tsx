import { Skeleton } from "@/components/ui/skeleton";
import {
  DEFAULT_INSIGHTS_RETENTION,
  formatDays,
  type InsightsRetentionDays,
} from "@/lib/insights-retention";
import { usageMetrics, type UsageWindow } from "@/lib/insights-usage";

import { EstimatedCount } from "./EstimatedCount";
import { InsightsInfo } from "./InsightsInfo";

export function ReportingDevicesSummary({
  window,
  count,
  isPending,
  partial,
  retention = DEFAULT_INSIGHTS_RETENTION,
}: {
  readonly window: UsageWindow;
  readonly count: number | undefined;
  readonly isPending: boolean;
  readonly partial: boolean;
  readonly retention?: InsightsRetentionDays;
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
          Unique app installations that reported activity in the last{" "}
          {metric.period}, including no-change reports. Filtered by platform,
          channel, and app version. The chart counts unique reporting
          installations per {metric.interval}. Unique counts are estimates,
          typically within about 3%. On DynamoDB and Firestore the server
          updates totals in batches: when the Console cannot write to the
          database, totals can leave out up to a minute of the latest reports.
          Hourly counts are kept for {formatDays(retention.rawDays)} and daily
          counts for {formatDays(retention.dailyDays)}, so 12 months counts
          whole UTC days.
          {partial
            ? " Only part of the history is available; the total is a lower bound."
            : ""}
        </InsightsInfo>
      </div>
    </div>
  );
}
