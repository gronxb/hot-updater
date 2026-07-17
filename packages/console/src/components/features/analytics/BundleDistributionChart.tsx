import type { ActiveInstallationOverview } from "@hot-updater/plugin-core";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

const chartConfig = {
  installations: {
    label: "Installations",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const MAX_BARS = 8;

const compactBundleId = (bundleId: string): string =>
  bundleId.length > 14
    ? `${bundleId.slice(0, 8)}…${bundleId.slice(-5)}`
    : bundleId;

export function BundleDistributionChart({
  active,
}: {
  readonly active: ActiveInstallationOverview;
}) {
  const chartData = active.bundles.slice(0, MAX_BARS).map((bundle) => ({
    ...bundle,
    label: compactBundleId(bundle.bundleId),
  }));

  return (
    <ChartContainer
      aria-label="Latest reported bundle distribution chart"
      className="h-52 w-full aspect-auto"
      config={chartConfig}
      role="img"
    >
      <BarChart
        accessibilityLayer
        data={chartData}
        layout="vertical"
        margin={{ left: 4, right: 12 }}
      >
        <CartesianGrid horizontal={false} />
        <XAxis
          allowDecimals={false}
          axisLine={false}
          tickLine={false}
          type="number"
        />
        <YAxis
          axisLine={false}
          dataKey="label"
          tickLine={false}
          type="category"
          width={112}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              className="max-w-52 sm:max-w-none"
              labelFormatter={(_, payload) =>
                String(payload[0]?.payload.bundleId ?? "")
              }
              labelClassName="break-all"
            />
          }
        />
        <Bar
          dataKey="installations"
          fill="var(--color-installations)"
          isAnimationActive={false}
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}
