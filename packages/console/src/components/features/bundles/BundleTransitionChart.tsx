import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

interface SeriesPoint {
  readonly bucketStartMs: number;
  readonly value: number;
}

interface BundleTransitionChartProps {
  readonly installed: readonly SeriesPoint[];
  readonly recovered: readonly SeriesPoint[];
}

interface TransitionChartPoint {
  readonly bucketStartMs: number;
  readonly installed: number;
  readonly recovered: number;
}

const chartConfig = {
  installed: {
    label: "Installed",
    color: "var(--chart-2)",
  },
  recovered: {
    label: "Recovered",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function mergeTransitionSeries(
  installed: readonly SeriesPoint[],
  recovered: readonly SeriesPoint[],
): TransitionChartPoint[] {
  const recoveredByBucket = new Map(
    recovered.map((point) => [point.bucketStartMs, point.value] as const),
  );

  return installed.map((point) => ({
    bucketStartMs: point.bucketStartMs,
    installed: point.value,
    recovered: recoveredByBucket.get(point.bucketStartMs) ?? 0,
  }));
}

function formatBucket(value: number): string {
  return dateFormatter.format(new Date(value));
}

export function BundleTransitionChart({
  installed,
  recovered,
}: BundleTransitionChartProps) {
  const chartData = mergeTransitionSeries(installed, recovered);
  const hasWindowActivity = chartData.some(
    (point) => point.installed > 0 || point.recovered > 0,
  );

  return (
    <div className="flex flex-col gap-3 border-t pt-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <div className="text-sm font-medium">30-day activity</div>
          <div className="text-xs text-muted-foreground">
            Cumulative distinct installations
          </div>
        </div>
        <Badge variant="secondary">UTC</Badge>
      </div>

      {hasWindowActivity ? (
        <ChartContainer
          aria-label="Cumulative OTA transition counts over the last 30 days"
          className="h-44 w-full aspect-auto"
          config={chartConfig}
        >
          <AreaChart
            accessibilityLayer
            data={chartData}
            margin={{ left: -16, right: 4, top: 8 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="bucketStartMs"
              minTickGap={28}
              tickFormatter={formatBucket}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
              width={32}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const bucket = payload[0]?.payload.bucketStartMs;
                    return typeof bucket === "number"
                      ? formatBucket(bucket)
                      : "";
                  }}
                />
              }
            />
            <Area
              dataKey="installed"
              fill="var(--color-installed)"
              fillOpacity={0.12}
              stroke="var(--color-installed)"
              strokeWidth={2}
              type="monotone"
            />
            <Area
              dataKey="recovered"
              fill="var(--color-recovered)"
              fillOpacity={0.06}
              stroke="var(--color-recovered)"
              strokeWidth={2}
              type="monotone"
            />
          </AreaChart>
        </ChartContainer>
      ) : (
        <div className="flex h-44 items-center justify-center rounded-lg border border-dashed px-6 text-center text-sm text-muted-foreground">
          No transition activity in the last 30 days.
        </div>
      )}
    </div>
  );
}
