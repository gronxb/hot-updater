import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  BundleActivityInput,
  BundleActivityReport,
} from "@/lib/bundle-activity";
import { getReleaseActivityRpc } from "@/lib/insights-recovery-rpc";
import { cn } from "@/lib/utils";

import { BundleActivityChart } from "./BundleActivityChart";

const activityStats = [
  { label: "Active", field: "activeInstallations", color: "text-success/85" },
  {
    label: "Pending",
    field: "pendingInstallations",
    color: "text-muted-foreground",
  },
  {
    label: "Downloaded",
    field: "downloadedInstallations",
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
  readonly report?: BundleActivityReport;
  readonly loading?: boolean;
}) {
  if (!report)
    return loading ? (
      <Skeleton aria-label="Loading bundle activity" className="h-4 w-32" />
    ) : (
      <span
        aria-label="Bundle activity unavailable"
        className="text-sm text-muted-foreground"
      >
        —
      </span>
    );
  const summary = report.summary;
  return (
    <div
      role="group"
      aria-label="Bundle activity over collected history"
      title={
        "Active: last observed release per installation. Downloaded and Recovered: distinct installations over collected history."
      }
      className="flex min-w-[140px] items-baseline gap-3 whitespace-nowrap"
    >
      {activityStats.map(({ label, field, color }) => (
        <span key={field} className="flex items-baseline gap-1.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span
            className={cn(
              "text-sm font-medium tabular-nums",
              summary[field] > 0 ? color : "text-muted-foreground",
            )}
          >
            {summary[field]}
          </span>
        </span>
      ))}
      {report.coverage.kind === "partial" ? (
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
    queryFn: () => getReleaseActivityRpc({ data: activityInput }),
    staleTime: 30_000,
  });
  const report = query.data;
  const activity = report?.data[0];
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-3">
        <CardTitle className="text-sm font-medium">Release activity</CardTitle>
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
            <dl className="grid grid-cols-4 gap-4">
              {activityStats.map(({ label, field, color }) => (
                <div key={field}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd
                    className={cn(
                      "mt-1 text-xl font-semibold tabular-nums",
                      (activity?.summary[field] ?? 0) > 0
                        ? color
                        : "text-muted-foreground",
                    )}
                  >
                    {activity?.summary[field] ?? 0}
                  </dd>
                </div>
              ))}
            </dl>
            <div>
              <p className="mb-2 text-xs text-muted-foreground">
                Reports · 24 hours · UTC
              </p>
              <BundleActivityChart series={activity?.series} />
            </div>
            {report?.coverage.kind === "partial" ? (
              <p className="text-xs text-muted-foreground">Partial history</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
