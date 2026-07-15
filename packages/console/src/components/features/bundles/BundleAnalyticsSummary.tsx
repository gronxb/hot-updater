import type { Bundle } from "@hot-updater/plugin-core";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBundleEventAnalyticsQuery } from "@/lib/api";

import { BundleTransitionChart } from "./BundleTransitionChart";

interface BundleAnalyticsSummaryProps {
  bundle: Bundle;
}

function LifetimeMetric({
  colorClassName,
  label,
  value,
}: {
  colorClassName: string;
  label: string;
  value: number;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${colorClassName}`}
        />
        {label}
      </dt>
      <dd className="text-3xl font-semibold tracking-tight tabular-nums">
        {value}
      </dd>
    </div>
  );
}

export function BundleAnalyticsSummary({
  bundle,
}: BundleAnalyticsSummaryProps) {
  const { data, error, isLoading } = useBundleEventAnalyticsQuery({
    bundleId: bundle.id,
    window: "30d",
    limit: 1,
    offset: 0,
  });

  return (
    <Card>
      <CardHeader className="gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-medium">Update activity</CardTitle>
          <Badge variant="outline">Lifetime</Badge>
        </div>
        <CardDescription>
          Distinct installations that reached or recovered from this bundle.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {isLoading ? (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-2 gap-6">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
            <Skeleton className="h-44 w-full" />
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Analytics unavailable</AlertTitle>
            <AlertDescription>
              {error instanceof Error
                ? error.message
                : "Failed to load bundle analytics."}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <dl className="grid grid-cols-2 divide-x divide-border/70">
              <div className="pr-5">
                <LifetimeMetric
                  colorClassName="bg-chart-2"
                  label="Installed"
                  value={data?.summary.installed ?? 0}
                />
              </div>
              <div className="pl-5">
                <LifetimeMetric
                  colorClassName="bg-chart-1"
                  label="Recovered"
                  value={data?.summary.recovered ?? 0}
                />
              </div>
            </dl>

            <BundleTransitionChart
              installed={data?.series.installed ?? []}
              recovered={data?.series.recovered ?? []}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
