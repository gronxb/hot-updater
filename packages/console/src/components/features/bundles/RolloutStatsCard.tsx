import { Activity } from "lucide-react";
import { Label, Pie, PieChart } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useRolloutStatsQuery } from "@/lib/api";

interface RolloutStatsCardProps {
  bundleId: string;
}

export function RolloutStatsCard({ bundleId }: RolloutStatsCardProps) {
  const { data: stats, isLoading } = useRolloutStatsQuery(bundleId);

  const totalDevices = stats?.totalDevices ?? 0;
  const successRate = stats?.successRate ?? 0;
  const promotedCount = stats?.promotedCount ?? 0;
  const recoveredCount = stats?.recoveredCount ?? 0;

  const chartData = [
    { status: "promoted", count: promotedCount, fill: "var(--color-promoted)" },
    {
      status: "recovered",
      count: recoveredCount,
      fill: "var(--color-recovered)",
    },
  ];

  const chartConfig = {
    count: {
      label: "Devices",
    },
    promoted: {
      label: "Promoted",
      color: "var(--event-promoted)",
    },
    recovered: {
      label: "Recovered",
      color: "var(--event-recovered)",
    },
  } satisfies ChartConfig;

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-24" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[140px] w-full" />
        </CardContent>
      </Card>
    );
  }

  const hasData = totalDevices > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 pb-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <CardTitle className="text-sm font-medium">Rollout Stats</CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        {hasData ? (
          <div className="flex items-center gap-4">
            <ChartContainer
              config={chartConfig}
              className="aspect-square h-[120px]"
            >
              <PieChart>
                <ChartTooltip
                  cursor={false}
                  content={<ChartTooltipContent hideLabel />}
                />
                <Pie
                  data={chartData}
                  dataKey="count"
                  nameKey="status"
                  innerRadius={36}
                  outerRadius={52}
                  strokeWidth={2}
                >
                  <Label
                    content={({ viewBox }) => {
                      if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                        return (
                          <text
                            x={viewBox.cx}
                            y={viewBox.cy}
                            textAnchor="middle"
                            dominantBaseline="middle"
                          >
                            <tspan
                              x={viewBox.cx}
                              y={viewBox.cy}
                              className="fill-foreground text-xl font-bold"
                            >
                              {successRate}%
                            </tspan>
                            <tspan
                              x={viewBox.cx}
                              y={(viewBox.cy || 0) + 14}
                              className="fill-muted-foreground text-[10px]"
                            >
                              Success
                            </tspan>
                          </text>
                        );
                      }
                    }}
                  />
                </Pie>
              </PieChart>
            </ChartContainer>

            <div className="flex-1 grid grid-cols-2 gap-3">
              <div className="space-y-0.5">
                <p className="text-[10px] text-muted-foreground">Total Reach</p>
                <p className="text-lg font-bold">
                  {totalDevices.toLocaleString()}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-[10px] text-muted-foreground">Promoted</p>
                <p className="text-lg font-bold text-success">
                  {promotedCount.toLocaleString()}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-[10px] text-muted-foreground">Recovered</p>
                <p className="text-lg font-bold text-[color:var(--event-recovered)]">
                  {recoveredCount.toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
              <Activity className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">
              No rollout data yet
            </p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Stats will appear once devices receive this bundle
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
