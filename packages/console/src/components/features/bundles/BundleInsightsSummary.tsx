import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useBundleActivityQuery,
  type BundleActivityInput,
} from "@/lib/bundle-activity";
import type { RecoveryReport } from "@/lib/insights-recovery";

import { BundleActivityChart } from "./BundleActivityChart";

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
          : "Active: last observed ID per installation. Rollbacks: distinct installations recovered from this ID in 30 days."
      }
      className="flex min-w-[140px] items-baseline gap-3 whitespace-nowrap"
    >
      <span className="flex items-baseline gap-1.5">
        <span className="text-xs text-muted-foreground">Active</span>
        <span className="text-sm font-medium tabular-nums">
          {series?.activeInstallations ?? 0}
        </span>
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-xs text-muted-foreground">Rollback</span>
        <span className="text-sm font-medium tabular-nums">
          {series?.recoveredInstallations ?? 0}
        </span>
      </span>
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
  const query = useBundleActivityQuery([input]);
  const report = query.data?.[input.releaseId];
  const series = report?.series[0];
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-3">
        <CardTitle className="text-sm font-medium">
          Activity · 30 days
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
            <dl className="grid grid-cols-2 divide-x divide-border/70">
              <div className="pr-4">
                <dt className="text-xs text-muted-foreground">Active</dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums">
                  {series?.activeInstallations ?? 0}
                </dd>
              </div>
              <div className="pl-4">
                <dt className="text-xs text-muted-foreground">
                  Rollback · 30d
                </dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums">
                  {series?.recoveredInstallations ?? 0}
                </dd>
              </div>
            </dl>
            <BundleActivityChart series={series} />
            <p className="text-xs text-muted-foreground">
              Last observed active installations · daily rollbacks
              {report?.truncated ? " · Partial history" : ""}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
