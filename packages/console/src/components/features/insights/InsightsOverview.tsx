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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RecoveryInput, RecoveryReport } from "@/lib/insights-recovery";
import type { HealthChart } from "@/lib/insights-search";
import { cn } from "@/lib/utils";

import { BundleDistributionChart } from "./BundleDistributionChart";
import { EstimatedCount } from "./EstimatedCount";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsInfo } from "./InsightsInfo";
import { InsightsPeriodSelector } from "./InsightsPeriodSelector";
import { ReleaseAdoptionChart } from "./ReleaseAdoptionChart";

const dates = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const rate = (report: RecoveryReport): string => {
  const attempts = report.activeDays + report.failedLaunches;
  return attempts === 0
    ? "—"
    : `${((report.failedLaunches / attempts) * 100).toFixed(2)}%`;
};

function ReleaseHealth({
  report,
  releaseId,
  window,
  chart,
  onChartChange,
  onReleaseChange,
  onWindowChange,
}: {
  readonly report: RecoveryReport;
  readonly releaseId?: string;
  readonly window: RecoveryInput["window"];
  readonly onWindowChange: (window: RecoveryInput["window"]) => void;
  readonly chart: HealthChart;
  readonly onChartChange: (chart: HealthChart) => void;
  readonly onReleaseChange: (releaseId: string) => void;
}) {
  const attempts = report.activeDays + report.failedLaunches;
  const activeInstallations = (
    <EstimatedCount value={report.activeInstallations} />
  );
  const metrics = [
    ["Active installations", activeInstallations],
    ["Active days", report.activeDays.toLocaleString()],
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
              {label === "Active installations" ? (
                <InsightsInfo label="About active installations">
                  Distinct installations that reported in this scope and period,
                  or that launched this release, estimated: typically within
                  about 3%.
                </InsightsInfo>
              ) : label === "Active days" ? (
                <InsightsInfo label="About active days">
                  Each installation counts once for each UTC day it launched,
                  and once more on a day an update applies or recovers. The
                  activity totals include these additional reports.
                </InsightsInfo>
              ) : label === "Crash rate" ? (
                <InsightsInfo label="About crash rate">
                  Reported OTA launch failures divided by active days plus
                  failed launches for the same scope and period.
                </InsightsInfo>
              ) : null}
            </dt>
            <dd className="text-3xl font-semibold tracking-tight tabular-nums">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <Tabs
        value={chart}
        onValueChange={(value) => onChartChange(value as HealthChart)}
        className="gap-5"
      >
        <TabsList
          aria-label="Release health chart"
          className="min-h-11 sm:min-h-9"
        >
          <TabsTrigger value="share" className="px-3">
            Bundle share
          </TabsTrigger>
          <TabsTrigger value="adoption" className="px-3">
            Adoption
          </TabsTrigger>
          <TabsTrigger value="failures" className="px-3">
            Launch failures
          </TabsTrigger>
        </TabsList>
        <TabsContent value="share">
          <BundleDistributionChart
            history={report.distribution}
            releaseId={releaseId}
          />
        </TabsContent>
        <TabsContent value="adoption">
          <ReleaseAdoptionChart
            report={report}
            releaseId={releaseId}
            window={window}
            onReleaseChange={onReleaseChange}
            onWindowChange={onWindowChange}
          />
        </TabsContent>
        <TabsContent value="failures">
          {report.points.length === 0 ? (
            <Empty className="min-h-64">
              <EmptyHeader>
                <EmptyTitle>No launch reports in this period.</EmptyTitle>
                <EmptyDescription>
                  Choose a longer period or refresh after an app reports.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ChartContainer
              aria-label="Daily failed launches"
              className="h-64 w-full aspect-auto"
              config={{
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
                <YAxis
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                />
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
                  dataKey="failedLaunches"
                  stroke="var(--color-failedLaunches)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartContainer>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function InsightsOverview({
  input,
  onWindowChange,
  query,
  onRefresh,
  chart,
  onChartChange,
  onReleaseChange,
}: {
  readonly input: RecoveryInput;
  readonly chart: HealthChart;
  readonly onChartChange: (chart: HealthChart) => void;
  /** Chooses the Release health release, as the Release ID filter does. */
  readonly onReleaseChange: (releaseId: string) => void;
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
                <RotateCw
                  aria-hidden="true"
                  className={cn(query.isFetching && "motion-safe:animate-spin")}
                />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent aria-busy={query.isFetching} className="px-6 pb-6">
          {query.isPending ? (
            <Skeleton aria-label="Loading release health" className="h-80" />
          ) : query.error ? (
            <InsightsErrorAlert
              error={query.error}
              fallbackTitle="Release health unavailable"
            />
          ) : query.data ? (
            <ReleaseHealth
              report={query.data}
              releaseId={input.releaseId}
              window={input.window}
              onWindowChange={onWindowChange}
              chart={chart}
              onChartChange={onChartChange}
              onReleaseChange={onReleaseChange}
            />
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
