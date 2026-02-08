import { Smartphone } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { AppVersionData } from "@/lib/analytics-utils";
import { getSuccessRateVariant } from "@/lib/status-utils";

interface AppVersionChartProps {
  data: AppVersionData[];
  isLoading?: boolean;
}

const chartConfig = {
  promoted: {
    label: "Promoted",
    color: "var(--event-promoted)",
  },
  recovered: {
    label: "Recovered",
    color: "var(--event-recovered)",
  },
} satisfies ChartConfig;

export function AppVersionChart({ data, isLoading }: AppVersionChartProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-10 w-20" />
            <Skeleton className="h-10 flex-1" />
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[300px] text-center">
        <Smartphone className="h-12 w-12 mb-4 opacity-20 text-muted-foreground" />
        <h3 className="text-lg font-medium text-foreground">
          No app version data available
        </h3>
        <p className="text-sm text-muted-foreground max-w-[400px] mt-2">
          Events will appear here as devices with different app versions
          interact with your updates.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ChartContainer config={chartConfig} className="h-[400px] w-full">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ left: 100, right: 120, top: 10, bottom: 10 }}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="appVersion"
            width={95}
            tick={{ fontSize: 11 }}
            tickFormatter={(value: string) => {
              // Truncate long version names
              if (value.length > 15) {
                return `${value.slice(0, 15)}...`;
              }
              return value;
            }}
          />
          <ChartTooltip
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) {
                return null;
              }

              const data = payload[0].payload as AppVersionData;

              return (
                <div className="rounded-lg border bg-background p-3 shadow-sm">
                  <div className="space-y-2">
                    <div className="font-medium text-sm">{data.appVersion}</div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: "var(--color-promoted)" }}
                        />
                        <span className="text-muted-foreground">Promoted:</span>
                        <span className="font-medium">{data.promoted}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: "var(--color-recovered)" }}
                        />
                        <span className="text-muted-foreground">
                          Recovered:
                        </span>
                        <span className="font-medium">{data.recovered}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs pt-1 border-t">
                      <span className="text-muted-foreground">
                        Success Rate:
                      </span>
                      <span className="font-medium">
                        {data.successRate.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>
              );
            }}
            cursor={{ fill: "hsl(var(--muted))" }}
          />
          <Bar
            dataKey="promoted"
            fill="var(--color-promoted)"
            stackId="a"
            radius={[0, 4, 4, 0]}
          />
          <Bar
            dataKey="recovered"
            fill="var(--color-recovered)"
            stackId="a"
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ChartContainer>

      {/* Success rate legend */}
      <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded bg-success-muted" />
          <span>≥ 90% Success Rate</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded bg-warning-muted" />
          <span>70-89% Success Rate</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded bg-error-muted" />
          <span>&lt; 70% Success Rate</span>
        </div>
      </div>

      {/* Table view with success rate badges */}
      <div className="rounded-md border">
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium">App Version</th>
                <th className="px-4 py-3 text-right font-medium">Promoted</th>
                <th className="px-4 py-3 text-right font-medium">Recovered</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 text-right font-medium">
                  Success Rate
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.map((version) => (
                <tr key={version.appVersion} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-mono text-xs">
                    {version.appVersion}
                  </td>
                  <td className="px-4 py-3 text-right text-success">
                    {version.promoted.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-[color:var(--event-recovered)]">
                    {version.recovered.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">
                    {version.total.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Badge variant={getSuccessRateVariant(version.successRate)}>
                      {version.successRate.toFixed(1)}%
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
