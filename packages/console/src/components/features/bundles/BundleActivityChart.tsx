import type { ActiveInstallationWindow } from "@hot-updater/plugin-core";
import { useId } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

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

interface BundleActivityChartProps {
  readonly installed: readonly SeriesPoint[];
  readonly recovered: readonly SeriesPoint[];
  readonly window: ActiveInstallationWindow;
}

interface ActivityChartPoint {
  readonly bucketStartMs: number;
  readonly installed: number;
  readonly recovered: number;
}

const chartConfig = {
  installed: {
    label: "Newly applied",
    color: "var(--chart-2)",
  },
  recovered: {
    label: "Recovered away",
    color: "var(--muted-foreground)",
  },
} satisfies ChartConfig;

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const hourFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  hour: "numeric",
  month: "short",
  timeZone: "UTC",
});

const windowLabels = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
} as const;

const mergeActivitySeries = (
  installed: readonly SeriesPoint[],
  recovered: readonly SeriesPoint[],
): readonly ActivityChartPoint[] => {
  const installedByBucket = new Map(
    installed.map((point) => [point.bucketStartMs, point.value] as const),
  );
  const recoveredByBucket = new Map(
    recovered.map((point) => [point.bucketStartMs, point.value] as const),
  );
  const buckets = new Set([
    ...installedByBucket.keys(),
    ...recoveredByBucket.keys(),
  ]);

  return [...buckets]
    .sort((left, right) => left - right)
    .map((bucketStartMs) => ({
      bucketStartMs,
      installed: installedByBucket.get(bucketStartMs) ?? 0,
      recovered: recoveredByBucket.get(bucketStartMs) ?? 0,
    }));
};

const formatBucket = (
  value: number,
  window: ActiveInstallationWindow,
): string =>
  (window === "24h" ? hourFormatter : dateFormatter).format(new Date(value));

export function BundleActivityChart({
  installed,
  recovered,
  window,
}: BundleActivityChartProps) {
  const captionId = useId();
  const chartData = mergeActivitySeries(installed, recovered);
  const hasWindowActivity = chartData.some(
    (point) => point.installed > 0 || point.recovered > 0,
  );

  if (!hasWindowActivity) {
    return (
      <div className="flex h-28 items-center justify-center border-t px-4 pt-4 text-center text-sm text-muted-foreground">
        No bundle movement in this period.
      </div>
    );
  }

  return (
    <div className="border-t pt-4">
      <ChartContainer
        aria-describedby={captionId}
        aria-label={`Bundle movement over ${windowLabels[window]}`}
        className="h-32 w-full aspect-auto"
        config={chartConfig}
        role="img"
      >
        <AreaChart
          accessibilityLayer
          data={chartData}
          margin={{ left: -16, right: 4, top: 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="bucketStartMs"
            minTickGap={28}
            tickFormatter={(value: number) => formatBucket(value, window)}
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
                    ? formatBucket(bucket, window)
                    : "";
                }}
              />
            }
          />
          <Area
            dataKey="installed"
            fill="var(--color-installed)"
            fillOpacity={0.12}
            isAnimationActive={false}
            stroke="var(--color-installed)"
            strokeWidth={2}
            type="monotone"
          />
          <Area
            dataKey="recovered"
            fill="var(--color-recovered)"
            fillOpacity={0.04}
            isAnimationActive={false}
            stroke="var(--color-recovered)"
            strokeWidth={1.5}
            type="monotone"
          />
        </AreaChart>
      </ChartContainer>
      <div className="sr-only">
        <table>
          <caption id={captionId}>
            Distinct bundle movement in each bucket over {windowLabels[window]}.
            Times are shown in UTC.
          </caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Newly applied</th>
              <th scope="col">Recovered away</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((point) => (
              <tr key={point.bucketStartMs}>
                <th scope="row">{formatBucket(point.bucketStartMs, window)}</th>
                <td>{point.installed}</td>
                <td>{point.recovered}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
