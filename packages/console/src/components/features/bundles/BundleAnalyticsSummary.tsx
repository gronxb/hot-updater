import type { Bundle } from "@hot-updater/plugin-core";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBundleEventSummaryQuery } from "@/lib/api";

interface BundleAnalyticsSummaryProps {
  bundle: Bundle;
}

function SummaryValue({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

export function BundleAnalyticsSummary({
  bundle,
}: BundleAnalyticsSummaryProps) {
  const { data, error, isLoading } = useBundleEventSummaryQuery(bundle.id);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">OTA Transitions</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {isLoading ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        ) : error ? (
          <div className="text-sm text-destructive sm:col-span-2">
            {error instanceof Error
              ? error.message
              : "Failed to load bundle transition analytics."}
          </div>
        ) : (
          <>
            <SummaryValue
              label="Lifetime Installed"
              value={data?.installed ?? 0}
            />
            <SummaryValue
              label="Lifetime Recovered"
              value={data?.recovered ?? 0}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
