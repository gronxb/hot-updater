import type {
  ActiveInstallationOverview,
  ActiveInstallationWindow,
} from "@hot-updater/server";
import { Link } from "@tanstack/react-router";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { buttonVariants } from "@/components/ui/button";
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

  if (!hasReports) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">No activity</p>
        <Link
          className={buttonVariants({
            variant: "outline",
            className: "h-11 px-3 lg:h-8",
          })}
          to="/installations"
        >
          View events
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs text-muted-foreground">Per {bucketName} · UTC</p>
      <ChartContainer
        aria-label={`Active installations per ${bucketName}`}
        className="h-40 w-full aspect-auto sm:h-56"
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
      <div className="sr-only">
        <table aria-label={`Exact active installations per ${bucketName}`}>
          <caption>
            Unique installations that reported an update status in each UTC
            {` ${bucketName}`}. Each bucket deduplicates installations
            separately; the period total deduplicates across the whole period.
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
