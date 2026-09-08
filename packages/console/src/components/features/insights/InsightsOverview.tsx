import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ListIcon, RotateCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RecoveryInput, RecoveryReport } from "@/lib/insights-recovery";
import { cn } from "@/lib/utils";

import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsPeriodSelector } from "./InsightsPeriodSelector";

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
const colors = [
  "var(--chart-2)",
  "var(--foreground)",
  "var(--chart-1)",
  "var(--muted-foreground)",
  "var(--chart-4)",
];
const dashes = [undefined, "6 3", "2 3"];

export function ActivityChart({ report }: { readonly report: RecoveryReport }) {
  const [metric, setMetric] = useState<"active" | "rollback">("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = report.series.find(
    (series) => series.releaseId === selectedId,
  );
  const config = Object.fromEntries(
    report.series.map((series, index) => [
      `bundle${index}`,
      {
        label: series.releaseId,
        color: colors[index % colors.length],
      },
    ]),
  );
  const data = (report.series[0]?.points ?? []).map((point, pointIndex) => ({
    startMs: point.startMs,
    ...Object.fromEntries(
      report.series.map((series, index) => [
        `bundle${index}`,
        metric === "active"
          ? series.points[pointIndex].active
          : series.points[pointIndex].recoveredInstallations,
      ]),
    ),
  }));
  const formatTick = (ms: number) =>
    (report.intervalMs < 86_400_000 ? times : dates).format(ms);
  const lastSpike = selected
    ? [...selected.points].reverse().find((point) => point.spike)
    : undefined;
  const total =
    metric === "active"
      ? report.series.reduce(
          (sum, series) => sum + series.activeInstallations,
          0,
        )
      : report.series.filter((series) => series.recoveredInstallations > 0)
          .length;
  return (
    <Tabs
      value={metric}
      onValueChange={(value) => {
        if (value === "active" || value === "rollback") setMetric(value);
      }}
      className="gap-6"
    >
      <TabsList
        aria-label="Activity metric"
        variant="line"
        className="min-h-11 sm:min-h-9"
      >
        <TabsTrigger className="min-w-24 px-4" value="active">
          Active
        </TabsTrigger>
        <TabsTrigger className="min-w-24 px-4" value="rollback">
          Rollback
        </TabsTrigger>
      </TabsList>
      <TabsContent value={metric} className="flex flex-col gap-4">
        <div className="flex items-baseline gap-3">
          <p className="text-4xl font-semibold tracking-tight tabular-nums">
            {total.toLocaleString()}
          </p>
          <p className="text-sm text-muted-foreground">
            {metric === "active"
              ? "Active installations"
              : "Bundles with rollbacks"}
          </p>
        </div>
        {report.series.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-center text-sm text-muted-foreground">
            No bundle reports in this period. Try another channel or check again
            after the app reports activity.
          </div>
        ) : (
          <>
            <div>
              <p className="mb-2 text-right text-xs text-muted-foreground">
                {metric === "active"
                  ? "Installations"
                  : "Recovered installations per interval"}{" "}
                · UTC
              </p>
              <ChartContainer
                aria-label={`${metric === "active" ? "Active" : "Rollback"} trend for all reported bundle IDs`}
                className="h-56 w-full aspect-auto sm:h-64"
                config={config}
              >
                <LineChart
                  accessibilityLayer
                  data={data}
                  margin={{ left: -12, right: 12, top: 8 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis
                    tick={{ fill: "var(--muted-foreground)" }}
                    axisLine={false}
                    dataKey="startMs"
                    minTickGap={40}
                    tickFormatter={formatTick}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: "var(--muted-foreground)" }}
                    allowDecimals={false}
                    axisLine={false}
                    tickLine={false}
                    width={48}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        className="max-h-64 max-w-[calc(100vw-3rem)] overflow-auto"
                        labelFormatter={(_, payload) =>
                          `${times.format(payload[0]?.payload.startMs)} · UTC`
                        }
                      />
                    }
                  />
                  {report.series.map((series, index) => (
                    <Line
                      key={series.releaseId}
                      dataKey={`bundle${index}`}
                      type="linear"
                      stroke={`var(--color-bundle${index})`}
                      strokeWidth={selectedId === series.releaseId ? 3 : 2}
                      strokeOpacity={!selected || selected === series ? 1 : 0.4}
                      strokeDasharray={
                        dashes[
                          Math.floor(index / colors.length) % dashes.length
                        ]
                      }
                      dot={{ r: 2 }}
                      activeDot={{ r: 4 }}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ChartContainer>
            </div>
            <ScrollArea
              aria-label="Reported bundles"
              className="min-w-0 [&_[data-slot=scroll-area-viewport]]:max-h-48"
            >
              <div
                className={cn(
                  "grid grid-cols-1 gap-1 pr-3",
                  report.series.length > 1 && "xl:grid-cols-2",
                )}
              >
                {report.series.map((series, index) => (
                  <button
                    type="button"
                    key={series.releaseId}
                    aria-label={`Highlight bundle ${series.releaseId}`}
                    aria-pressed={selectedId === series.releaseId}
                    title={series.releaseId}
                    onClick={() =>
                      setSelectedId(
                        selectedId === series.releaseId
                          ? null
                          : series.releaseId,
                      )
                    }
                    className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted"
                  >
                    <svg
                      aria-hidden="true"
                      width="20"
                      height="8"
                      className="shrink-0"
                    >
                      <line
                        x1="0"
                        x2="20"
                        y1="4"
                        y2="4"
                        stroke={colors[index % colors.length]}
                        strokeWidth="2"
                        strokeDasharray={
                          dashes[
                            Math.floor(index / colors.length) % dashes.length
                          ]
                        }
                      />
                    </svg>
                    <span className="min-w-0 truncate font-mono">
                      {series.releaseId}
                    </span>
                    {series.points.some((point) => point.spike) ? (
                      <TriangleAlert
                        aria-label="Rollback spike"
                        className="size-3 shrink-0"
                      />
                    ) : null}
                    <span className="ml-auto tabular-nums">
                      {(metric === "active"
                        ? series.activeInstallations
                        : series.recoveredInstallations
                      ).toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
            </ScrollArea>
            {selected ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                <div className="min-w-0 flex-1">
                  <p className="break-all font-mono text-xs">
                    {selected.releaseId}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Active {selected.activeInstallations.toLocaleString()} ·
                    Rollback {selected.recoveredInstallations.toLocaleString()}{" "}
                    in this period
                  </p>
                  {metric === "rollback" && lastSpike ? (
                    <p className="mt-2 flex items-center gap-2 text-xs">
                      <TriangleAlert
                        className="size-3 shrink-0"
                        aria-hidden="true"
                      />
                      Rollback spike on {dates.format(lastSpike.startMs)}.
                      Review this bundle’s delivery settings.
                    </p>
                  ) : null}
                </div>
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  to="/"
                  search={{ releaseId: selected.releaseId }}
                >
                  Review bundle
                  <ArrowUpRight aria-hidden="true" />
                </Link>
              </div>
            ) : null}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">View chart data</summary>
              <div className="mt-2 max-h-64 overflow-auto">
                <table className="w-full text-left">
                  <caption className="sr-only">
                    {metric === "active"
                      ? "Active installations"
                      : "Recovered installations"}{" "}
                    by bundle ID, UTC
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className="pr-4">
                        Date (UTC)
                      </th>
                      {report.series.map((series) => (
                        <th
                          scope="col"
                          className="px-2 font-mono"
                          key={series.releaseId}
                        >
                          {series.releaseId}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((point, i) => (
                      <tr key={point.startMs}>
                        <th
                          scope="row"
                          className="whitespace-nowrap pr-4 font-normal"
                        >
                          {times.format(point.startMs)}
                        </th>
                        {report.series.map((series) => (
                          <td
                            className="px-2 tabular-nums"
                            key={series.releaseId}
                          >
                            {(metric === "active"
                              ? series.points[i].active
                              : series.points[i].recoveredInstallations) ?? "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </TabsContent>
    </Tabs>
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
    <Card
      aria-label="Bundle activity"
      className="min-w-0 overflow-hidden shadow-sm"
      role="region"
    >
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-4 p-6">
        <CardTitle>Bundle activity</CardTitle>
        <div className="flex w-full items-center justify-between gap-4 sm:w-auto">
          <InsightsPeriodSelector
            window={input.window}
            onWindowChange={onWindowChange}
          />
          <Button
            aria-label="Refresh bundle activity"
            className="size-11 sm:size-9"
            variant="ghost"
            size="icon-lg"
            disabled={query.isFetching}
            onClick={onRefresh}
          >
            <RotateCw aria-hidden="true" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-6 pb-6">
        {query.isPending ? (
          <Skeleton
            aria-label="Loading bundle activity"
            className="h-80 w-full"
          />
        ) : query.error ? (
          <InsightsErrorAlert
            error={query.error}
            fallbackTitle="Bundle activity unavailable"
          />
        ) : query.data ? (
          <ActivityChart key={JSON.stringify(input)} report={query.data} />
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap items-center justify-between gap-4 border-t px-6 py-5">
        <div className="flex min-w-0 basis-64 flex-1 flex-col gap-2 text-xs text-muted-foreground">
          {query.data && !query.error ? (
            <>
              <p>
                Active follows each installation’s last reported ID in this
                period. Rollbacks count recovered installations per interval.
              </p>
              {query.data.unattributedInstallations > 0 ? (
                <p>
                  {query.data.unattributedInstallations.toLocaleString()}{" "}
                  reporting installations have no observed bundle ID and are
                  excluded.
                </p>
              ) : null}
              {query.data.truncated ? (
                <p>
                  Partial history — only reports since{" "}
                  {times.format(query.data.sinceMs)} UTC are included. Choose a
                  shorter period to see more complete counts.
                </p>
              ) : null}
            </>
          ) : (
            <p>Browse individual reports in the event log.</p>
          )}
        </div>
        <Link
          className={cn(
            buttonVariants({
              className: "h-11 px-4 sm:h-9",
              size: "lg",
              variant: "outline",
            }),
          )}
          to="/installations"
        >
          <ListIcon aria-hidden="true" data-icon="inline-start" />
          All events
        </Link>
      </CardFooter>
    </Card>
  );
}
