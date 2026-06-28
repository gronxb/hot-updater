import {
  Activity,
  type LucideIcon,
  RotateCcw,
  Signal,
  TriangleAlert,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useBundleMetricsQuery,
  type BundleMetrics,
  type BundleMetricsPoint,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const metricsChartConfig = {
  active: {
    label: "Active",
    color: "var(--chart-1)",
  },
  recovered: {
    label: "Recovered",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

const numberFormatter = new Intl.NumberFormat();

const displayCount = (value: number): string => numberFormatter.format(value);

const displayDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Current";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
};

type MetricsChartPoint = BundleMetricsPoint & {
  readonly bucketLabel: string;
};

function chartDataFor(metrics: BundleMetrics): readonly MetricsChartPoint[] {
  if (metrics.series.length > 0) {
    return metrics.series.map((point) => ({
      ...point,
      bucketLabel: displayDate(point.bucketStart),
    }));
  }

  return [
    {
      active: metrics.active,
      bucketLabel: "Current",
      bucketStart: metrics.lastSeenAt ?? "current",
      recovered: metrics.recovered,
    },
  ];
}

function recoveryPressure(metrics: BundleMetrics): string {
  const total = metrics.active + metrics.recovered;
  if (total === 0) {
    return "No app-ready signals yet";
  }

  return `${Math.round((metrics.recovered / total) * 100)}% recovered`;
}

function MetricTile({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-md border bg-muted/20 p-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="grid min-w-0 gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <strong className="truncate text-sm font-semibold tabular-nums">
          {value}
        </strong>
      </span>
    </div>
  );
}

export function BundleMetricsPanel({
  bundleId,
}: {
  readonly bundleId: string;
}) {
  const metricsQuery = useBundleMetricsQuery(bundleId);

  if (!metricsQuery.isSupported) {
    return null;
  }

  if (metricsQuery.isLoading) {
    return (
      <section
        aria-label="Bundle metrics"
        className="grid gap-4 rounded-lg border bg-card p-4"
      >
        <Skeleton className="h-4 w-40" />
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
        <Skeleton className="h-36 w-full" />
      </section>
    );
  }

  if (metricsQuery.isError) {
    return (
      <section
        aria-label="Bundle metrics"
        className="grid gap-3 rounded-lg border bg-card p-4 text-sm"
      >
        <div className="flex items-center gap-2 font-semibold">
          <TriangleAlert className="h-4 w-4 text-muted-foreground" />
          Bundle metrics
        </div>
        <p className="text-muted-foreground">
          Bundle metrics could not be loaded for this bundle.
        </p>
      </section>
    );
  }

  const metrics = metricsQuery.data;
  if (!metrics) {
    return (
      <section
        aria-label="Bundle metrics"
        className="grid gap-3 rounded-lg border bg-card p-4 text-sm"
      >
        <div className="flex items-center gap-2 font-semibold">
          <Signal className="h-4 w-4 text-muted-foreground" />
          Bundle metrics
        </div>
        <p className="text-muted-foreground">
          This provider supports bundle metrics, but this bundle has no
          app-ready signals yet.
        </p>
      </section>
    );
  }

  const chartData = chartDataFor(metrics);

  return (
    <section
      aria-label="Bundle metrics"
      className="grid gap-4 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h3 className="text-sm font-semibold">Bundle metrics</h3>
          <p className="text-xs text-muted-foreground">
            Provider supplied active installs and recovery signals for this
            bundle.
          </p>
        </div>
        {metrics.lastSeenAt ? (
          <span className="rounded-md border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
            Last seen {displayDate(metrics.lastSeenAt)}
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile
          icon={Signal}
          label="Active installs"
          value={`${displayCount(metrics.active)} active`}
        />
        <MetricTile
          icon={RotateCcw}
          label="Recovered installs"
          value={`${displayCount(metrics.recovered)} recovered`}
        />
        <MetricTile
          icon={Activity}
          label="Recovery pressure"
          value={recoveryPressure(metrics)}
        />
      </div>

      <ChartContainer
        config={metricsChartConfig}
        className={cn("h-40 min-h-40 w-full", chartData.length === 1 && "h-32")}
      >
        <BarChart accessibilityLayer data={[...chartData]}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="bucketLabel"
            tickLine={false}
            tickMargin={8}
            axisLine={false}
          />
          <YAxis tickLine={false} axisLine={false} width={28} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="active" fill="var(--color-active)" radius={4} />
          <Bar dataKey="recovered" fill="var(--color-recovered)" radius={4} />
        </BarChart>
      </ChartContainer>
    </section>
  );
}
