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

type ActivityPoint = ActiveInstallationOverview["series"][number];

const chartConfig = {
  value: {
    label: "Active installations",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

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

export function ActivityChart({
  series,
  window,
}: {
  readonly series: readonly ActivityPoint[];
  readonly window: ActiveInstallationWindow;
}) {
  const hasReports = series.some(({ value }) => value > 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {!hasReports && (
        <p className="text-sm text-muted-foreground">
          No active installations in this range.
        </p>
      )}
      <ChartContainer
        aria-label="Non-cumulative active installation trend"
        className="h-64 w-full aspect-auto"
        config={chartConfig}
        role="img"
      >
        <AreaChart
          accessibilityLayer
          data={series}
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
            dataKey="value"
            fill="var(--color-value)"
            fillOpacity={0.14}
            isAnimationActive={false}
            stroke="var(--color-value)"
            strokeWidth={2}
            type="monotone"
          />
        </AreaChart>
      </ChartContainer>
      <div className="sr-only">
        <table aria-label="Exact active installation values">
          <caption>
            Distinct active installations in each UTC bucket. Values are not
            cumulative.
          </caption>
          <thead>
            <tr>
              <th scope="col">UTC bucket</th>
              <th scope="col">Active installations</th>
            </tr>
          </thead>
          <tbody>
            {series.map((point) => (
              <tr key={point.bucketStartMs}>
                <th scope="row">{formatBucket(point.bucketStartMs, window)}</th>
                <td>{point.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
