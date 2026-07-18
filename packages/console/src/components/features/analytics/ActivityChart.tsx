import type {
  ActiveInstallationOverview,
  ActiveInstallationWindow,
} from "@hot-updater/plugin-core";
import { useId } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";

type BundleSeries = ActiveInstallationOverview["bundleSeries"][number];

const MAX_VISIBLE_BUNDLES = 5;
const seriesKeys = [
  "bundle0",
  "bundle1",
  "bundle2",
  "bundle3",
  "bundle4",
] as const;
const seriesColors = [
  "var(--chart-2)",
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;
const swatchClasses = [
  "bg-chart-2",
  "bg-chart-1",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
] as const;

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

const formatBundleLabel = (bundleId: string): string =>
  bundleId.length > 20
    ? `${bundleId.slice(0, 8)}…${bundleId.slice(-6)}`
    : bundleId;

export function ActivityChart({
  bundleSeries,
  window,
}: {
  readonly bundleSeries: readonly BundleSeries[];
  readonly window: ActiveInstallationWindow;
}) {
  const captionId = useId();
  const visibleSeries = bundleSeries.slice(0, MAX_VISIBLE_BUNDLES);
  const remainingSeries = bundleSeries.slice(MAX_VISIBLE_BUNDLES);
  const firstSeries = bundleSeries[0]?.series ?? [];
  const chartData = firstSeries.map((point, index) => ({
    bucketStartMs: point.bucketStartMs,
    bundle0: visibleSeries[0]?.series[index]?.value ?? 0,
    bundle1: visibleSeries[1]?.series[index]?.value ?? 0,
    bundle2: visibleSeries[2]?.series[index]?.value ?? 0,
    bundle3: visibleSeries[3]?.series[index]?.value ?? 0,
    bundle4: visibleSeries[4]?.series[index]?.value ?? 0,
    other: remainingSeries.reduce(
      (total, bundle) => total + (bundle.series[index]?.value ?? 0),
      0,
    ),
  }));
  const hasReports = bundleSeries.some((bundle) =>
    bundle.series.some(({ value }) => value > 0),
  );
  const chartConfig = {
    bundle0: {
      label: formatBundleLabel(visibleSeries[0]?.bundleId ?? "Bundle 1"),
      color: seriesColors[0],
    },
    bundle1: {
      label: formatBundleLabel(visibleSeries[1]?.bundleId ?? "Bundle 2"),
      color: seriesColors[1],
    },
    bundle2: {
      label: formatBundleLabel(visibleSeries[2]?.bundleId ?? "Bundle 3"),
      color: seriesColors[2],
    },
    bundle3: {
      label: formatBundleLabel(visibleSeries[3]?.bundleId ?? "Bundle 4"),
      color: seriesColors[3],
    },
    bundle4: {
      label: formatBundleLabel(visibleSeries[4]?.bundleId ?? "Bundle 5"),
      color: seriesColors[4],
    },
    other: {
      label: "Other bundles",
      color: "var(--muted-foreground)",
    },
  } satisfies ChartConfig;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {!hasReports && (
        <p className="text-sm text-muted-foreground">
          No installations reported during this period.
        </p>
      )}
      <ChartContainer
        aria-describedby={captionId}
        aria-label="Reporting installations by bundle over time"
        className="h-64 w-full aspect-auto"
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
          {visibleSeries.map((bundle, index) => {
            const seriesKey = seriesKeys[index];
            if (!seriesKey) return null;
            return (
              <Area
                dataKey={seriesKey}
                fill={`var(--color-${seriesKey})`}
                fillOpacity={0.14}
                isAnimationActive={false}
                key={bundle.bundleId}
                stroke={`var(--color-${seriesKey})`}
                strokeWidth={2}
                type="monotone"
              />
            );
          })}
          {remainingSeries.length > 0 ? (
            <Area
              dataKey="other"
              fill="var(--color-other)"
              fillOpacity={0.08}
              isAnimationActive={false}
              stroke="var(--color-other)"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              type="monotone"
            />
          ) : null}
        </AreaChart>
      </ChartContainer>
      <div
        className="flex flex-wrap gap-x-4 gap-y-2"
        aria-label="Bundle series"
      >
        {visibleSeries.map((bundle, index) => (
          <div
            className="flex min-w-0 items-center gap-2"
            key={bundle.bundleId}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-[2px]",
                swatchClasses[index],
              )}
            />
            <code className="max-w-48 truncate text-xs text-muted-foreground">
              {formatBundleLabel(bundle.bundleId)}
            </code>
          </div>
        ))}
        {remainingSeries.length > 0 ? (
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2 rounded-[2px] bg-muted-foreground"
            />
            <span className="text-xs text-muted-foreground">
              Other ({remainingSeries.length})
            </span>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground" id={captionId}>
        Each time bucket counts an installation once under the bundle in its
        latest status report. Bucket counts reset and do not accumulate.
      </p>
      <div className="sr-only">
        <table aria-label="Exact reporting installations by bundle">
          <caption>
            Each installation is counted once per UTC bucket under the bundle in
            its latest status report. Counts reset in every bucket and are not
            cumulative.
          </caption>
          <thead>
            <tr>
              <th scope="col">UTC bucket</th>
              {visibleSeries.map((bundle) => (
                <th key={bundle.bundleId} scope="col">
                  {bundle.bundleId}
                </th>
              ))}
              {remainingSeries.length > 0 ? (
                <th scope="col">Other bundles</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {chartData.map((point, index) => (
              <tr key={point.bucketStartMs}>
                <th scope="row">{formatBucket(point.bucketStartMs, window)}</th>
                {visibleSeries.map((bundle) => (
                  <td key={bundle.bundleId}>
                    {bundle.series[index]?.value ?? 0}
                  </td>
                ))}
                {remainingSeries.length > 0 ? <td>{point.other}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
