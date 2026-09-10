import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { BundleActivityInput } from "@/lib/bundle-activity";
import type { RecoveryReport } from "@/lib/insights-recovery";
import { getRecoveryReportRpc } from "@/lib/insights-recovery-rpc";
import { cn } from "@/lib/utils";

import { BundleActivityChart } from "./BundleActivityChart";

const activityStats = [
  { label: "Active", field: "activeInstallations", color: "text-success/85" },
  {
    label: "Downloaded",
    field: "pendingInstallations",
    color: "text-primary/85",
  },
  {
    label: "Recovered",
    field: "recoveredInstallations",
    color: "text-warning/85",
  },
] as const;

export function BundleMovementSummary({
  report,
  loading = false,
}: {
  readonly report?: RecoveryReport;
  readonly loading?: boolean;
}) {
  if (!report)
    return loading ? (
      <Skeleton aria-label="Loading bundle activity" className="h-4 w-32" />
    ) : (
      <span
        aria-label="30-day bundle activity unavailable"
        className="text-sm text-muted-foreground"
      >
        —
      </span>
    );
  const series = report.series[0];
  return (
    <div
      role="group"
      aria-label="Bundle activity over 30 days"
      title={
        report.truncated
          ? "Partial history. Counts include only the available reports."
          : "Active: last observed running ID per installation. Downloaded: waiting to apply. Recovered: distinct installations recovered from this ID in 30 days."
      }
      className="flex min-w-[140px] items-baseline gap-3 whitespace-nowrap"
    >
      {activityStats.map(({ label, field, color }) => (
        <span key={field} className="flex items-baseline gap-1.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span
            className={cn(
              "text-sm font-medium tabular-nums",
              (series?.[field] ?? 0) > 0 ? color : "text-muted-foreground",
            )}
          >
            {series?.[field] ?? 0}
          </span>
        </span>
      ))}
      {report.truncated ? (
        <span className="text-xs text-muted-foreground">Partial</span>
      ) : null}
    </div>
  );
}

export function BundleInsightsSummary({
  input,
}: {
  readonly input: BundleActivityInput;
}) {
  const activityInput = { ...input, window: "24h" } as const;
  const query = useQuery({
    queryKey: ["rollout-activity", activityInput],
    queryFn: () => getRecoveryReportRpc({ data: activityInput }),
    staleTime: 30_000,
  });
  const report = query.data;
  const series = report?.series[0];
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-3">
        <CardTitle className="text-sm font-medium">
          Activity · 24 hours
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 pb-4">
        {query.isPending ? (
          <Skeleton
            aria-label="Loading bundle activity"
            className="h-32 w-full"
          />
        ) : query.error ? (
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            Insights unavailable
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-4">
              {activityStats.map(({ label, field, color }) => (
                <div key={field}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd
                    className={cn(
                      "mt-1 text-xl font-semibold tabular-nums",
                      (series?.[field] ?? 0) > 0
                        ? color
                        : "text-muted-foreground",
                    )}
                  >
                    {series?.[field] ?? 0}
                  </dd>
                </div>
              ))}
            </dl>
            <BundleActivityChart series={series} />
            {report?.truncated ? (
              <p className="text-xs text-muted-foreground">Partial history</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
