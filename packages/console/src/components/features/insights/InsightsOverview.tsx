import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, RotateCw, TriangleAlert } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { RecoveryInput, RecoveryReport } from "@/lib/insights-recovery";
import { getRecoveryReportRpc } from "@/lib/insights-recovery-rpc";

import { InsightsErrorAlert } from "./InsightsErrorAlert";

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
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            {metric === "active"
              ? "Active installations"
              : "Bundles with rollbacks"}
          </p>
          <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">
            {total.toLocaleString()}
          </p>
        </div>
        <ToggleGroup
          aria-label="Activity metric"
          value={[metric]}
          onValueChange={(values) => {
            if (values[0] === "active" || values[0] === "rollback")
              setMetric(values[0]);
          }}
          spacing={0}
          variant="outline"
        >
          <ToggleGroupItem className="h-11 lg:h-8" value="active">
            Active
          </ToggleGroupItem>
          <ToggleGroupItem className="h-11 lg:h-8" value="rollback">
            Rollback
          </ToggleGroupItem>
        </ToggleGroup>
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
              className="h-48 w-full aspect-auto sm:h-56"
              config={config}
            >
              <LineChart
                accessibilityLayer
                data={data}
                margin={{ left: -12, right: 12, top: 8 }}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="startMs"
                  minTickGap={40}
                  tickFormatter={formatTick}
                  tickLine={false}
                />
                <YAxis
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
                      dashes[Math.floor(index / colors.length) % dashes.length]
                    }
                    dot={{ r: 2 }}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ChartContainer>
          </div>
          <div
            aria-label="Reported bundles"
            className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2"
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
                    selectedId === series.releaseId ? null : series.releaseId,
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
                      dashes[Math.floor(index / colors.length) % dashes.length]
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
          {selected ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
              <div className="min-w-0 flex-1">
                <p className="break-all font-mono text-xs">
                  {selected.releaseId}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Active {selected.activeInstallations.toLocaleString()} ·
                  Rollback {selected.recoveredInstallations.toLocaleString()} in
                  this period
                </p>
                {metric === "rollback" && lastSpike ? (
                  <p className="mt-2 flex items-center gap-2 text-xs">
                    <TriangleAlert
                      className="size-3 shrink-0"
                      aria-hidden="true"
                    />
                    Rollback spike on {dates.format(lastSpike.startMs)}. Review
                    this bundle’s delivery settings.
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
    </>
  );
}

export function InsightsOverview({ input }: { readonly input: RecoveryInput }) {
  const query = useQuery({
    queryKey: ["rollout-activity", input],
    queryFn: () => getRecoveryReportRpc({ data: input }),
    staleTime: 30_000,
  });
  return (
    <Card className="min-w-0 overflow-hidden shadow-sm">
      <CardHeader className="flex-row items-center justify-between gap-4 px-4 pt-4 pb-2 sm:px-6 sm:pt-6">
        <CardTitle className="text-sm font-medium">
          Bundle activity ·{" "}
          {input.window === "30d"
            ? "30 days"
            : input.window === "7d"
              ? "7 days"
              : "24 hours"}
        </CardTitle>
        <Button
          aria-label="Refresh bundle activity"
          variant="ghost"
          size="icon-sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RotateCw aria-hidden="true" />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4 pb-4 sm:px-6 sm:pb-6">
        {query.isPending ? (
          <Skeleton
            aria-label="Loading bundle activity"
            className="h-64 w-full"
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
      {query.data && !query.error ? (
        <CardFooter className="flex-col items-start gap-2 border-t bg-muted/15 px-4 py-3 text-xs text-muted-foreground sm:px-6">
          <p>
            Active follows each installation’s last reported ID in this period.
            Rollbacks count installations recovered from each ID per interval.
          </p>
          {query.data.unattributedInstallations > 0 ? (
            <p>
              {query.data.unattributedInstallations.toLocaleString()} reporting
              installations have no observed bundle ID and are excluded.
            </p>
          ) : null}
          {query.data.truncated ? (
            <p>
              Partial history — only reports since{" "}
              {times.format(query.data.sinceMs)} UTC are included. Choose a
              shorter period to see more complete counts.
            </p>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}
