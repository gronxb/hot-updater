import type {
  ActiveInstallationOverview,
  ActiveInstallationWindow,
} from "@hot-updater/plugin-core";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

type ActivitySeries = ActiveInstallationOverview["series"];

const dayFormatter = new Intl.DateTimeFormat("en", {
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

const formatBucket = (
  bucketStartMs: number,
  window: ActiveInstallationWindow,
): string =>
  (window === "24h" ? hourFormatter : dayFormatter).format(
    new Date(bucketStartMs),
  );

const chartConfig = {
  installations: {
    label: "Active installations",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

export function ActivityChart({
  series,
  window,
}: {
  readonly series: ActivitySeries;
  readonly window: ActiveInstallationWindow;
}) {
  const chartData = series.map((point) => ({
    bucketStartMs: point.bucketStartMs,
    installations: point.value,
  }));
  const hasReports = series.some(({ value }) => value > 0);
  const bucketName = window === "24h" ? "hour" : "day";

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <h3 className="text-sm font-medium">Activity over time</h3>
          <p className="text-xs text-muted-foreground">
            Unique active installations per {bucketName}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">UTC</span>
      </div>
      {!hasReports && (
        <p className="text-sm text-muted-foreground">
          No installations reported during this period.
        </p>
      )}
      <ChartContainer
        aria-label={`Active installations per ${bucketName}`}
        className="h-64 w-full aspect-auto"
        config={chartConfig}
        role="img"
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
            dataKey="installations"
            fill="var(--color-installations)"
            fillOpacity={0.12}
            isAnimationActive={false}
            stroke="var(--color-installations)"
            strokeWidth={2}
            type="monotone"
          />
        </AreaChart>
      </ChartContainer>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Each point counts an installation once in that {bucketName}. The total
        above counts it once across the whole period, so the points do not add
        up to the total.
      </p>
      <div className="sr-only">
        <table aria-label={`Exact active installations per ${bucketName}`}>
          <caption>
            Unique installations that reported an update status in each UTC
            {` ${bucketName}`}.
          </caption>
          <thead>
            <tr>
              <th scope="col">UTC {bucketName}</th>
              <th scope="col">Active installations</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((point) => (
              <tr key={point.bucketStartMs}>
                <th scope="row">{formatBucket(point.bucketStartMs, window)}</th>
                <td>{point.installations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
