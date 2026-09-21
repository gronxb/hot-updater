import { Link } from "@tanstack/react-router";
import { ListIcon, RotateCw } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { RecoveryInput, RecoveryReport } from "@/lib/insights-recovery";

import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsInfo } from "./InsightsInfo";
import { InsightsPeriodSelector } from "./InsightsPeriodSelector";

const dates = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const rate = (report: RecoveryReport): string => {
  const attempts = report.launches + report.failedLaunches;
  return attempts === 0
    ? "—"
    : `${((report.failedLaunches / attempts) * 100).toFixed(2)}%`;
};

function ReleaseHealth({ report }: { readonly report: RecoveryReport }) {
  const attempts = report.launches + report.failedLaunches;
  const metrics = [
    ["Unique users", report.uniqueUsers.toLocaleString()],
    ["Launches", report.launches.toLocaleString()],
    ["Failed launches", report.failedLaunches.toLocaleString()],
    ["Crash rate", attempts === 0 ? "— / No launch reports" : rate(report)],
  ] as const;
  return (
    <div className="flex flex-col gap-8">
      <dl className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <dt className="flex items-center gap-1 text-sm text-muted-foreground">
              {label}
              {label === "Unique users" ? (
                <InsightsInfo label="About unique users">
                  Distinct installations with a reported successful launch in
                  this scope and period.
                </InsightsInfo>
              ) : label === "Crash rate" ? (
                <InsightsInfo label="About crash rate">
                  Reported OTA launch failures divided by successful launches
                  plus failed launches for the same scope and period.
                </InsightsInfo>
              ) : null}
            </dt>
            <dd className="text-3xl font-semibold tracking-tight tabular-nums">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {report.points.length === 0 ? (
        <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
          No launch reports in this period.
        </div>
      ) : (
        <ChartContainer
          aria-label="Daily launches and failed launches"
          className="h-64 w-full aspect-auto"
          config={{
            launches: { label: "Launches", color: "var(--chart-2)" },
            failedLaunches: {
              label: "Failed launches",
              color: "var(--chart-1)",
            },
          }}
        >
          <LineChart data={report.points} margin={{ left: -12, right: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="startMs"
              tickFormatter={(value) => dates.format(value)}
              tickLine={false}
            />
            <YAxis allowDecimals={false} axisLine={false} tickLine={false} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    `${dates.format(payload[0]?.payload.startMs)} · UTC`
                  }
                />
              }
            />
            <Line
              dataKey="launches"
              stroke="var(--color-launches)"
              strokeWidth={2}
              isAnimationActive={false}
            />
            <Line
              dataKey="failedLaunches"
              stroke="var(--color-failedLaunches)"
              strokeWidth={2}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      )}
    </div>
  );
}

export function InsightsOverview({
  input,
  onWindowChange,
  query,
  onRefresh,
}: {
  readonly input: RecoveryInput;
  readonly query: {
    readonly data: RecoveryReport | undefined;
    readonly error: Error | null;
    readonly isPending: boolean;
    readonly isFetching: boolean;
  };
  readonly onRefresh: () => void;
  readonly onWindowChange: (window: RecoveryInput["window"]) => void;
}) {
  return (
    <section aria-label="Release health">
      <Card className="min-w-0 overflow-hidden shadow-sm">
        <CardHeader className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <CardTitle>Release health</CardTitle>
            <div className="flex items-center gap-2">
              <InsightsPeriodSelector
                window={input.window}
                onWindowChange={onWindowChange}
              />
              <Button
                aria-label="Refresh release health"
                variant="ghost"
                size="icon-lg"
                disabled={query.isFetching}
                onClick={onRefresh}
              >
                <RotateCw aria-hidden="true" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          {query.isPending ? (
            <Skeleton aria-label="Loading release health" className="h-80" />
          ) : query.error ? (
            <InsightsErrorAlert
              error={query.error}
              fallbackTitle="Release health unavailable"
            />
          ) : query.data ? (
            <ReleaseHealth report={query.data} />
          ) : null}
        </CardContent>
        <CardFooter className="flex items-center justify-between border-t px-6 py-5">
          {query.data?.coverage.kind === "partial" ? (
            <span className="text-xs text-muted-foreground">Partial</span>
          ) : (
            <span />
          )}
          <Link
            className={buttonVariants({ variant: "outline", size: "sm" })}
            to="/installations"
          >
            <ListIcon aria-hidden="true" />
            Event history
          </Link>
        </CardFooter>
      </Card>
    </section>
  );
}
