import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BundleAdoption } from "@/lib/analytics-overview";

const chartConfig = {
  trackedInstallations: {
    label: "Tracked installations",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const percentage = (share: number): string =>
  new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(share);

export function AdoptionChart({
  adoption,
}: {
  readonly adoption: readonly BundleAdoption[];
}) {
  return (
    <div className="flex flex-col gap-5">
      <ChartContainer
        aria-label="Observed bundle adoption"
        className="h-56 w-full aspect-auto"
        config={chartConfig}
      >
        <BarChart
          accessibilityLayer
          data={adoption}
          layout="vertical"
          margin={{ left: 8, right: 12 }}
        >
          <CartesianGrid horizontal={false} />
          <XAxis allowDecimals={false} axisLine={false} type="number" />
          <YAxis
            axisLine={false}
            dataKey="bundleId"
            tickFormatter={(value: string) =>
              value.length > 12 ? `${value.slice(0, 9)}…` : value
            }
            tickLine={false}
            type="category"
            width={88}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value) => (
                  <span className="font-mono font-medium tabular-nums">
                    {Number(value).toLocaleString()} tracked
                  </span>
                )}
                hideLabel={false}
              />
            }
          />
          <Bar
            dataKey="trackedInstallations"
            fill="var(--color-trackedInstallations)"
            isAnimationActive={false}
            radius={[0, 3, 3, 0]}
          />
        </BarChart>
      </ChartContainer>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Bundle</TableHead>
            <TableHead>Observed adoption</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {adoption.map((item) => (
            <TableRow key={item.bundleId}>
              <TableCell className="max-w-56 whitespace-normal">
                <div className="flex flex-col gap-1">
                  <code className="break-all text-xs">{item.bundleId}</code>
                  {item.bundle ? (
                    <span className="text-muted-foreground">
                      {item.bundle.platform} · {item.bundle.channel}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      Bundle metadata unavailable
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="tabular-nums">
                {item.trackedInstallations.toLocaleString()} tracked ·{" "}
                {percentage(item.observedShare)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
