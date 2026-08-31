import { useInsightsCapability } from "@/components/features/insights/InsightsCapabilityContext";
import { InsightsErrorAlert } from "@/components/features/insights/InsightsErrorAlert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBundleEventInsightsQuery } from "@/lib/api";

import { BundleActivityChart } from "./BundleActivityChart";

interface BundleInsightsSummaryProps {
  readonly bundleId: string;
}

function Metric({
  label,
  tone,
  value,
}: {
  readonly label: string;
  readonly tone: "applied" | "recovered";
  readonly value: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className={
            tone === "applied"
              ? "size-2 rounded-full bg-chart-2"
              : "size-2 rounded-full bg-muted-foreground"
          }
        />
        {label}
      </dt>
      <dd className="text-xl font-semibold tracking-tight tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function SupportedBundleInsightsSummary({
  bundleId,
}: BundleInsightsSummaryProps) {
  const { data, error, isLoading } = useBundleEventInsightsQuery(
    {
      bundleId,
      window: "30d",
      limit: 1,
      offset: 0,
    },
    true,
  );

  return (
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="text-sm font-medium">
          Activity · 30 days
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 pb-4">
        {isLoading ? (
          <div
            aria-label="Loading reported bundle outcomes"
            className="flex flex-col gap-3"
          >
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
            <Skeleton className="h-24 w-full sm:h-32" />
          </div>
        ) : error ? (
          <InsightsErrorAlert
            error={
              error instanceof Error
                ? error
                : new Error("Failed to load bundle insights.")
            }
            fallbackTitle="Insights unavailable"
          />
        ) : (
          <>
            <dl className="grid grid-cols-2 divide-x divide-border/70">
              <div className="pr-4">
                <Metric
                  label="Applied"
                  tone="applied"
                  value={data?.summary.installed ?? 0}
                />
              </div>
              <div className="pl-4">
                <Metric
                  label="Recovered"
                  tone="recovered"
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

export function BundleInsightsSummary({
  bundleId,
}: BundleInsightsSummaryProps) {
  const capability = useInsightsCapability();

  if (capability.status !== "supported") {
    return null;
  }

  return <SupportedBundleInsightsSummary bundleId={bundleId} />;
}
