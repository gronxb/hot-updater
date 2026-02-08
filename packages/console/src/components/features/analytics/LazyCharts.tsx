import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { AppVersionChartProps } from "./AppVersionChart";
import type { TimeSeriesChartProps } from "./TimeSeriesChart";

// Lazy load chart components to reduce initial bundle size (~100KB)
const AppVersionChart = lazy(() =>
  import("./AppVersionChart").then((mod) => ({
    default: mod.AppVersionChart,
  })),
);

const TimeSeriesChart = lazy(() =>
  import("./TimeSeriesChart").then((mod) => ({
    default: mod.TimeSeriesChart,
  })),
);

// Skeleton fallback for charts
function ChartSkeleton() {
  return (
    <div className="space-y-[var(--spacing-tight)]">
      {[...Array(5)].map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

// Lazy-loaded wrapper components
export function LazyAppVersionChart(props: AppVersionChartProps) {
  return (
    <Suspense fallback={<ChartSkeleton />}>
      <AppVersionChart {...props} />
    </Suspense>
  );
}

export function LazyTimeSeriesChart(props: TimeSeriesChartProps) {
  return (
    <Suspense fallback={<ChartSkeleton />}>
      <TimeSeriesChart {...props} />
    </Suspense>
  );
}
