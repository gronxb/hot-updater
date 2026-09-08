import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronRight } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { PlatformIcon } from "@/components/PlatformIcon";
import { Badge } from "@/components/ui/badge";
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
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { InsightsWindow } from "@/lib/insights-api";
import type { InsightsSearch } from "@/lib/insights-search";
import type { AppUsageReport } from "@/lib/insights-usage";

import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsInfo } from "./InsightsInfo";
import { InsightsPeriodSelector } from "./InsightsPeriodSelector";
import { ReportingDevicesSummary } from "./ReportingDevicesSummary";

const dates = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const times = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  timeZone: "UTC",
});

export function AppUsage({
  query,
  search,
  window,
  onWindowChange,
}: {
  readonly query: UseQueryResult<AppUsageReport>;
  readonly search: InsightsSearch;
  readonly window: InsightsWindow;
  readonly onWindowChange: (window: InsightsWindow) => void;
}) {
  const report = query.error ? undefined : query.data;
  const formatTime = (ms: number) =>
    (window === "30d" ? dates : times).format(ms);
  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <Card aria-label="App usage" role="region" className="min-w-0 shadow-sm">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-4">
          <CardTitle>App usage</CardTitle>
          <InsightsPeriodSelector
            window={window}
            onWindowChange={onWindowChange}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ReportingDevicesSummary
            window={window}
            count={report?.activeInstallations}
            isPending={query.isPending}
            partial={report?.truncated ?? false}
          />
          {query.isPending ? (
            <Skeleton aria-label="Loading app usage" className="h-48" />
          ) : query.error ? (
            <div className="flex flex-col items-start gap-4">
              <InsightsErrorAlert
                error={query.error}
                fallbackTitle="App usage unavailable"
              />
              <Button variant="outline" onClick={() => void query.refetch()}>
                Retry app usage
              </Button>
            </div>
          ) : report?.activeInstallations === 0 ? (
            <Empty className="h-48">
              <EmptyHeader>
                <EmptyTitle>No activity reported</EmptyTitle>
                <EmptyDescription>
                  Try another period, platform, channel, or app version.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : report ? (
            <>
              <div>
                <p className="mb-2 text-right text-xs text-muted-foreground">
                  Reporting installations · UTC
                </p>
                <ChartContainer
                  aria-label="Active users per interval"
                  className="h-48 w-full aspect-auto"
                  config={{
                    installations: {
                      label: "Active users",
                      color: "var(--chart-2)",
                    },
                  }}
                >
                  <LineChart
                    accessibilityLayer
                    data={report.points}
                    margin={{ right: 8, top: 8 }}
                  >
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="startMs"
                      tick={{ fill: "var(--muted-foreground)" }}
                      tickFormatter={formatTime}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={45}
                    />
                    <YAxis
                      tick={{ fill: "var(--muted-foreground)" }}
                      allowDecimals={false}
                      axisLine={false}
                      tickLine={false}
                      width="auto"
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          labelFormatter={(_, payload) =>
                            `${times.format(payload[0]?.payload.startMs)} · UTC`
                          }
                        />
                      }
                    />
                    <Line
                      dataKey="installations"
                      type="linear"
                      stroke="var(--color-installations)"
                      strokeWidth={2}
                      dot={{ r: 2 }}
                      activeDot={{ r: 4 }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ChartContainer>
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer py-2">
                  View usage data
                </summary>
                <Table aria-label="App usage by interval">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval · UTC</TableHead>
                      <TableHead className="text-right">Active users</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.points.map((point) => (
                      <TableRow key={point.startMs}>
                        <TableCell>{times.format(point.startMs)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {point.installations?.toLocaleString() ?? "Unknown"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </details>
            </>
          ) : null}
        </CardContent>
      </Card>
      <Card
        aria-label="Usage distribution"
        role="region"
        className="min-w-0 self-start shadow-sm"
      >
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="flex min-h-9 items-center">
            Distribution
          </CardTitle>
          <InsightsInfo label="How distribution is counted">
            Each reporting installation is counted once, using the app version
            and platform of its latest matching report in the selected period.
            {report?.truncated
              ? " Shares reflect only the available history."
              : ""}
          </InsightsInfo>
        </CardHeader>
        <CardContent>
          {query.isPending ? (
            <Skeleton aria-label="Loading distribution" className="h-48" />
          ) : query.error ? (
            <InsightsErrorAlert
              error={query.error}
              fallbackTitle="Distribution unavailable"
            />
          ) : !report?.activeInstallations ? (
            <Empty className="h-40">
              <EmptyHeader>
                <EmptyTitle>No reporting installations</EmptyTitle>
                <EmptyDescription>
                  Try a different filter or period.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-6">
              {(["versions", "platforms"] as const).map((dimension) => (
                <section
                  key={dimension}
                  aria-label={
                    dimension === "versions"
                      ? "App version distribution"
                      : "Platform distribution"
                  }
                  className="flex flex-col gap-4"
                >
                  {dimension === "platforms" ? <Separator /> : null}
                  <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    {dimension === "versions" ? "App versions" : "Platforms"}
                    {dimension === "versions" ? (
                      <Badge variant="secondary">
                        {report.versions.length}
                      </Badge>
                    ) : null}
                  </h3>
                  <ScrollArea className="min-w-0 [&_[data-slot=scroll-area-viewport]]:max-h-40">
                    <dl className="flex flex-col gap-4 pr-4">
                      {report[dimension].map((row) => {
                        const name =
                          dimension === "platforms"
                            ? row.name === "ios"
                              ? "iOS"
                              : "Android"
                            : row.name;
                        const share =
                          (row.installations / report.activeInstallations) *
                          100;
                        return (
                          <div
                            key={row.name}
                            className="group relative flex min-h-11 flex-col gap-2 rounded-sm focus-within:ring-2 focus-within:ring-ring sm:min-h-0"
                          >
                            <div className="flex min-w-0 items-baseline justify-between gap-3">
                              <dt
                                className="flex min-w-0 items-center gap-2 text-sm"
                                title={name}
                              >
                                {dimension === "platforms" &&
                                (row.name === "ios" ||
                                  row.name === "android") ? (
                                  <PlatformIcon
                                    platform={row.name}
                                    className="size-4 shrink-0"
                                  />
                                ) : null}
                                {dimension === "versions" ? (
                                  <Link
                                    to="/insights/distribution"
                                    search={{ ...search, version: row.name }}
                                    aria-label={`View bundles for app version ${row.name}`}
                                    className="flex min-w-0 items-center gap-1 after:absolute after:inset-0 group-hover:underline"
                                  >
                                    <span className="truncate">{name}</span>
                                    <ChevronRight
                                      aria-hidden="true"
                                      className="size-3 shrink-0 text-muted-foreground"
                                    />
                                  </Link>
                                ) : (
                                  <span className="truncate">{name}</span>
                                )}
                              </dt>
                              <dd className="flex shrink-0 gap-3 text-sm tabular-nums">
                                <span>
                                  {row.installations.toLocaleString()}
                                </span>
                                <span className="min-w-10 text-right text-muted-foreground">
                                  {share.toFixed(1)}%
                                </span>
                              </dd>
                            </div>
                            <Progress
                              aria-label={`${name} share`}
                              aria-valuetext={`${row.installations} installations, ${share.toFixed(1)}%`}
                              value={share}
                            />
                          </div>
                        );
                      })}
                    </dl>
                  </ScrollArea>
                </section>
              ))}
            </div>
          )}
        </CardContent>
        <CardFooter className="border-t pt-4">
          <Link
            to="/insights/distribution"
            search={search}
            className={buttonVariants({
              variant: "outline",
              className: "h-11 w-full sm:h-9",
            })}
          >
            View distribution
            <ArrowRight aria-hidden="true" data-icon="inline-end" />
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
