import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { RecoveryInput, RecoveryReport } from "@/lib/insights-recovery";
import { getRecoveryReportRpc } from "@/lib/insights-recovery-rpc";

import { useInsightsTimeFormat } from "./EventDetails";
import { InsightsErrorAlert } from "./InsightsErrorAlert";

const percent = (rate: number | null) =>
  rate === null ? "No reports" : `${rate.toFixed(1)}%`;

export function RolloutChart({
  report,
  inSheet = false,
}: {
  readonly report: RecoveryReport;
  readonly inSheet?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [metric, setMetric] = useState<"adoption" | "recovery">(() =>
    report.series.some(({ points }) => points.some(({ spike }) => spike))
      ? "recovery"
      : "adoption",
  );
  const formatter = useInsightsTimeFormat();
  const series =
    report.series.find(({ releaseId }) => releaseId === selectedId) ??
    report.series[0];
  if (!series)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RotateCcw aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No rollout activity yet</EmptyTitle>
          <EmptyDescription>
            Try a different time window or check again after this deployment
            reports adoption or recovery.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const point =
    series.points.find(({ startMs }) => startMs === selectedTime) ??
    [...series.points].reverse().find(({ spike }) => spike) ??
    [...series.points]
      .reverse()
      .find(
        (item) =>
          (metric === "adoption" ? item.adoptionShare : item.rate) !== null,
      ) ??
    [...series.points].reverse().find(({ rate }) => rate !== null)!;
  const markerMs =
    series.firstAdoptedAtMs === null
      ? null
      : Math.floor(series.firstAdoptedAtMs / report.intervalMs) *
        report.intervalMs;
  const spikeCount = report.series.filter(({ points }) =>
    points.some(({ spike }) => spike),
  ).length;
  // Paint the selected ID last so it stays clickable where lines cross.
  const plotted =
    metric === "adoption"
      ? [...report.series.filter((item) => item !== series), series]
      : [series];
  const chartConfig = Object.fromEntries(
    plotted.map((item, index) => [
      `series${index}`,
      {
        label: `ID ${item.releaseId}`,
        color:
          item.releaseId === series.releaseId
            ? "var(--primary)"
            : "var(--muted-foreground)",
      },
    ]),
  );
  const chartData = series.points.map((item, pointIndex) => ({
    startMs: item.startMs,
    ...Object.fromEntries(
      plotted.map((deployment, index) => [
        `series${index}`,
        metric === "adoption"
          ? deployment.points[pointIndex].adoptionShare
          : deployment.points[pointIndex].rate,
      ]),
    ),
  }));
  const selectedValue =
    metric === "adoption" ? point.adoptionShare : point.rate;
  const tickTime = (value: number) =>
    new Intl.DateTimeFormat("en", {
      timeZone: formatter.resolvedOptions().timeZone,
      ...(report.intervalMs < 21_600_000
        ? { hour: "2-digit", minute: "2-digit" }
        : { month: "short", day: "numeric" }),
    }).format(value);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ToggleGroup
        aria-label="Rollout metric"
        variant="outline"
        spacing={0}
        value={[metric]}
        onValueChange={(values) => {
          const next = values[0];
          if (next === "adoption" || next === "recovery") {
            setSelectedTime(point.startMs);
            setMetric(next);
          }
        }}
      >
        <ToggleGroupItem value="adoption">New adoption</ToggleGroupItem>
        <ToggleGroupItem value="recovery">Recovery rate</ToggleGroupItem>
      </ToggleGroup>
      {!inSheet ? (
        <div className="flex min-w-0 flex-col gap-2">
          <Select
            value={series.releaseId}
            onValueChange={(value) => {
              setSelectedId(value);
              setSelectedTime(null);
            }}
          >
            <SelectTrigger
              aria-label="Deployment ID"
              className="w-full min-w-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {report.series.map((item) => (
                  <SelectItem key={item.releaseId} value={item.releaseId}>
                    {item.points.some(({ spike }) => spike)
                      ? "Review · "
                      : "ID · "}
                    {item.releaseId}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {spikeCount > 1 ? (
            <p className="text-xs text-muted-foreground">
              {spikeCount} deployments have recovery spikes. Select an ID to
              review its trend.
            </p>
          ) : null}
        </div>
      ) : null}
      {metric === "adoption" && !inSheet ? (
        <p className="text-xs text-muted-foreground">
          The highlighted line is the selected ID. Other IDs appear in gray;
          select a point to compare adoption and recovery.
        </p>
      ) : null}
      <ChartContainer
        config={chartConfig}
        className="h-56 w-full"
        aria-label={`${metric === "adoption" ? "New adoption share" : "Recovery rate"} for ID ${series.releaseId}`}
      >
        <LineChart
          accessibilityLayer
          data={chartData}
          margin={{ top: 24, left: -20, right: 16 }}
          onClick={(state) => {
            const index = Number(state.activeIndex);
            if (state.activeIndex != null && series.points[index])
              setSelectedTime(series.points[index].startMs);
          }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            tick={{ fill: "var(--muted-foreground)" }}
            dataKey="startMs"
            tickFormatter={tickTime}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
          />
          <YAxis
            tick={{ fill: "var(--muted-foreground)" }}
            domain={[0, 100]}
            tickFormatter={(value: number) => `${value}%`}
            tickLine={false}
            axisLine={false}
            ticks={[0, 25, 50, 75, 100]}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) =>
                  formatter.format(Number(payload[0]?.payload.startMs))
                }
                formatter={(value, name) => (
                  <span className="max-w-64 break-all font-medium tabular-nums">
                    {name}: {Number(value).toFixed(1)}%
                  </span>
                )}
              />
            }
          />
          {markerMs !== null ? (
            <ReferenceLine
              x={markerMs}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              label={{
                value: "First adoption",
                position: "insideTopLeft",
                fill: "var(--muted-foreground)",
                fontSize: 11,
              }}
            />
          ) : null}
          <ReferenceLine x={point.startMs} stroke="var(--border)" />
          {plotted.map((deployment, seriesIndex) => (
            <Line
              key={deployment.releaseId}
              name={`ID ${deployment.releaseId}`}
              dataKey={`series${seriesIndex}`}
              type="linear"
              stroke={`var(--color-series${seriesIndex})`}
              strokeWidth={2}
              connectNulls={false}
              isAnimationActive={false}
              dot={({ cx, cy, index }) => {
                const p = deployment.points[index];
                const value =
                  metric === "adoption" ? p?.adoptionShare : p?.rate;
                if (!p || value === null) return <g key={index} />;
                // SVG chart points cannot contain native HTML buttons.
                /* oxlint-disable jsx-a11y/prefer-tag-over-role */
                return (
                  <circle
                    key={index}
                    role="button"
                    tabIndex={0}
                    aria-label={`Inspect ID ${deployment.releaseId}, ${formatter.format(p.startMs)}: ${percent(value)} ${metric === "adoption" ? "new adoption" : "recovered"}`}
                    className="cursor-pointer focus-visible:stroke-foreground focus-visible:stroke-2"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedId(deployment.releaseId);
                      setSelectedTime(p.startMs);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        setSelectedId(deployment.releaseId);
                        setSelectedTime(p.startMs);
                      }
                    }}
                    cx={cx}
                    cy={cy}
                    r={metric === "recovery" && p.spike ? 5 : 3}
                    fill={
                      metric === "recovery" && p.spike
                        ? "var(--destructive)"
                        : `var(--color-series${seriesIndex})`
                    }
                  />
                );
                /* oxlint-enable jsx-a11y/prefer-tag-over-role */
              }}
            />
          ))}
        </LineChart>
      </ChartContainer>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">
            {metric === "adoption"
              ? "New adoption share in selected interval"
              : "Recovered in selected interval"}
          </p>
          <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">
            {selectedValue === null ? "—" : selectedValue.toFixed(1)}
            <span className="ml-1 text-lg font-medium text-muted-foreground">
              %
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {metric === "adoption"
              ? `${point.adopted.toLocaleString()} adoption reports · ${percent(point.rate)} recovered`
              : `${point.recovered.toLocaleString()} recovered / ${(point.adopted + point.recovered).toLocaleString()} adoption + recovery reports`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            aria-label="Previous interval"
            disabled={point === series.points[0]}
            onClick={() => setSelectedTime(point.startMs - report.intervalMs)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            aria-label="Next interval"
            disabled={point === series.points.at(-1)}
            onClick={() => setSelectedTime(point.startMs + report.intervalMs)}
          >
            Next
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {formatter.format(Math.max(point.startMs, report.sinceMs))} –{" "}
        {formatter.format(
          Math.min(
            point.startMs + report.intervalMs,
            report.beforeReceivedAtMs,
          ),
        )}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">ID</p>
          <p className="mt-1 break-all font-mono text-xs" translate="no">
            {series.releaseId}
          </p>
        </div>
        {!inSheet ? (
          <Link
            to="/"
            search={{ releaseId: series.releaseId }}
            className={buttonVariants({ variant: "outline" })}
          >
            Review deployment
            <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
          </Link>
        ) : null}
      </div>
      {point.spike ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Consider rolling back this deployment</AlertTitle>
          <AlertDescription>
            Recovery rose to {percent(point.rate)} after adoption began. Review
            rollout and Enabled settings before deciding to roll back.
          </AlertDescription>
        </Alert>
      ) : null}
      {markerMs !== null ? (
        <p className="text-xs text-muted-foreground">
          First adoption observed in this window:{" "}
          {formatter.format(series.firstAdoptedAtMs!)}.
        </p>
      ) : null}
    </div>
  );
}

export function InsightsRolloutCard({
  input,
  inSheet = false,
}: {
  readonly input: RecoveryInput;
  readonly inSheet?: boolean;
}) {
  const [sheetWindow, setSheetWindow] = useState(input.window);
  const queryInput = inSheet ? { ...input, window: sheetWindow } : input;
  const query = useQuery({
    queryKey: ["insights", "recovery", queryInput],
    queryFn: () => getRecoveryReportRpc({ data: queryInput }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  return (
    <Card className="min-w-0 overflow-hidden shadow-sm">
      <CardHeader>
        <CardTitle>Rollout activity</CardTitle>
        {inSheet ? (
          <Select
            value={sheetWindow}
            onValueChange={(value) => {
              if (value === "24h" || value === "7d" || value === "30d")
                setSheetWindow(value);
            }}
          >
            <SelectTrigger aria-label="Rollout time window" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
        <CardDescription>
          See new deployments take over and spot recovery spikes. Select a point
          to inspect its ID and interval.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isPending ? (
          <Skeleton
            aria-label="Loading rollout activity"
            className="h-80 w-full"
          />
        ) : query.error ? (
          <InsightsErrorAlert
            error={query.error}
            fallbackTitle="Rollout activity unavailable"
          />
        ) : (
          <>
            {query.data.truncated ? (
              <Alert>
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>Partial history</AlertTitle>
                <AlertDescription>
                  Only complete intervals from the latest 50,000 reports are
                  shown. Choose a shorter window to see more detail.
                </AlertDescription>
              </Alert>
            ) : null}
            <RolloutChart
              key={`${queryInput.platform}:${queryInput.channel}:${queryInput.window}:${queryInput.releaseId ?? ""}`}
              report={query.data}
              inSheet={inSheet}
            />
          </>
        )}
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-3">
        <p className="text-xs text-muted-foreground">
          New adoption shows each ID’s share of adoption reports in this
          platform and channel. Recovery is recovered ÷ (adopted + recovered).
          Only reports with an ID are included. Reports are not unique devices;
          gaps mean no reports.
        </p>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            When a spike needs review
          </summary>
          <p className="mt-2">
            At least 10 reports, 3 recoveries, a recovery rate of 10% or more,
            and a rise of 10 percentage points from the previous observed
            interval (0% at first adoption).
          </p>
        </details>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh rollout activity
        </Button>
      </CardFooter>
    </Card>
  );
}
