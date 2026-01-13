import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { TimeSeriesData } from "@/lib/analytics-utils";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid } from "recharts";
import { TrendingUp } from "lucide-react";

interface TimeSeriesChartProps {
  data: TimeSeriesData[];
  isLoading?: boolean;
}

const chartConfig = {
  promoted: {
    label: "Promoted",
    color: "hsl(142 76% 36%)", // Emerald
  },
  recovered: {
    label: "Recovered",
    color: "hsl(24 95% 53%)", // Orange
  },
} satisfies ChartConfig;

export function TimeSeriesChart({ data, isLoading }: TimeSeriesChartProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px] text-center">
        <TrendingUp className="h-12 w-12 mb-4 opacity-20 text-muted-foreground" />
        <h3 className="text-lg font-medium text-foreground">
          No event data for selected period
        </h3>
        <p className="text-sm text-muted-foreground max-w-[400px] mt-2">
          Try adjusting your date range or filters to see event activity over
          time.
        </p>
      </div>
    );
  }

  return (
    <ChartContainer config={chartConfig} className="h-[400px] w-full">
      <AreaChart
        data={data}
        margin={{ left: 20, right: 20, top: 10, bottom: 10 }}
      >
        <defs>
          <linearGradient id="fillPromoted" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor="var(--color-promoted)"
              stopOpacity={0.8}
            />
            <stop
              offset="95%"
              stopColor="var(--color-promoted)"
              stopOpacity={0.1}
            />
          </linearGradient>
          <linearGradient id="fillRecovered" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor="var(--color-recovered)"
              stopOpacity={0.8}
            />
            <stop
              offset="95%"
              stopColor="var(--color-recovered)"
              stopOpacity={0.1}
            />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12 }}
          tickFormatter={(value) => {
            // Truncate long labels
            return value.length > 10 ? `${value.slice(0, 10)}...` : value;
          }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12 }}
          allowDecimals={false}
        />
        <ChartTooltip
          content={<ChartTooltipContent />}
          cursor={{ stroke: "hsl(var(--muted))", strokeWidth: 1 }}
        />
        <Area
          type="monotone"
          dataKey="promoted"
          stackId="1"
          stroke="var(--color-promoted)"
          fill="url(#fillPromoted)"
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="recovered"
          stackId="1"
          stroke="var(--color-recovered)"
          fill="url(#fillRecovered)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}
