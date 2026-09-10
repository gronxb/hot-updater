import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { RecoverySeries } from "@/lib/insights-recovery";

const config = {
  active: { label: "Active", color: "var(--success)" },
  pendingInstallations: { label: "Downloaded", color: "var(--primary)" },
  recoveredInstallations: {
    label: "Recovered",
    color: "var(--warning)",
  },
};
const formatDate = (ms: number) =>
  new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    timeZone: "UTC",
  }).format(ms);

export function BundleActivityChart({
  series,
}: {
  readonly series?: RecoverySeries;
}) {
  if (!series)
    return (
      <p className="flex h-16 items-center justify-center border-t text-xs text-muted-foreground sm:h-20">
        No reports in 24 hours. Check again after the app reports activity.
      </p>
    );
  return (
    <div className="border-t pt-3">
      <ChartContainer
        aria-label="Bundle activity over 24 hours, UTC"
        className="h-32 w-full aspect-auto sm:h-40"
        config={config}
      >
        <AreaChart
          accessibilityLayer
          data={series.points}
          margin={{ left: -16, right: 4, top: 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="startMs"
            minTickGap={28}
            tickFormatter={formatDate}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <ChartLegend content={<ChartLegendContent />} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) =>
                  `${formatDate(payload[0]?.payload.startMs)} · UTC`
                }
              />
            }
          />
          <Area
            dataKey="active"
            dot={{ r: 2 }}
            fill="var(--color-active)"
            fillOpacity={0.12}
            isAnimationActive={false}
            stroke="var(--color-active)"
            strokeWidth={2}
            type="linear"
          />
          <Area
            dataKey="pendingInstallations"
            fill="var(--color-pendingInstallations)"
            fillOpacity={0.04}
            stroke="var(--color-pendingInstallations)"
            strokeDasharray="4 3"
            isAnimationActive={false}
            type="linear"
          />
          <Area
            dataKey="recoveredInstallations"
            fill="var(--color-recoveredInstallations)"
            fillOpacity={0.04}
            isAnimationActive={false}
            stroke="var(--color-recoveredInstallations)"
            strokeWidth={1.5}
            type="linear"
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
