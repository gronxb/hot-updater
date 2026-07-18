import type { Bundle } from "@hot-updater/plugin-core";

import { AnalyticsErrorAlert } from "@/components/features/analytics/AnalyticsErrorAlert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsCapabilityState } from "@/lib/analytics-api";
import { useBundleEventAnalyticsQuery } from "@/lib/api";

import { BundleActivityChart } from "./BundleActivityChart";

interface BundleAnalyticsSummaryProps {
  readonly bundle: Bundle;
  readonly capability: AnalyticsCapabilityState;
}

function Metric({
  colorClassName,
  label,
  value,
}: {
  readonly colorClassName: string;
  readonly label: string;
  readonly value: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${colorClassName}`}
        />
        {label}
      </dt>
      <dd className="text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function SupportedBundleAnalyticsSummary({
  bundle,
}: {
  readonly bundle: Bundle;
}) {
  const { data, error, isLoading } = useBundleEventAnalyticsQuery(
    {
      bundleId: bundle.id,
      window: "30d",
      limit: 1,
      offset: 0,
    },
    true,
  );

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-sm font-medium">
          Bundle movement · 30 days
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <div
            aria-label="Loading reported bundle outcomes"
            className="flex flex-col gap-4"
          >
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
            <Skeleton className="h-32 w-full" />
          </div>
        ) : error ? (
          <AnalyticsErrorAlert
            error={
              error instanceof Error
                ? error
                : new Error("Failed to load bundle analytics.")
            }
            fallbackTitle="Analytics unavailable"
          />
        ) : (
          <>
            <dl className="grid grid-cols-2 divide-x divide-border/70">
              <div className="pr-4">
                <Metric
                  colorClassName="bg-chart-2"
                  label="Newly applied"
                  value={data?.summary.installed ?? 0}
                />
              </div>
              <div className="pl-4">
                <Metric
                  colorClassName="bg-muted-foreground"
                  label="Recovered away"
                  value={data?.summary.recovered ?? 0}
                />
              </div>
            </dl>
            <BundleActivityChart
              installed={data?.series.installed ?? []}
              recovered={data?.series.recovered ?? []}
              window="30d"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function BundleAnalyticsSummary({
  bundle,
  capability,
}: BundleAnalyticsSummaryProps) {
  if (capability.status !== "supported") {
    return null;
  }

  return <SupportedBundleAnalyticsSummary bundle={bundle} />;
}
