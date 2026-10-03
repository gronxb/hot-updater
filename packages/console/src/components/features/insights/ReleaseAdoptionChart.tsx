import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

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
import type { RecoveryReport } from "@/lib/insights-recovery";

import { InsightsInfo } from "./InsightsInfo";

const HOUR = 3_600_000;
const times = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const intervalLabel = (intervalMs: number) =>
  intervalMs === 24 * HOUR
    ? "Daily"
    : intervalMs === HOUR
      ? "Hourly"
      : `${intervalMs / HOUR}-hour`;

/** The chosen release's downloads from its deployment, in the period. */
export function ReleaseAdoptionChart({
  report,
}: {
  readonly report: RecoveryReport;
}) {
  const adoption = report.adoption;
  const header = (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-sm font-medium">
        Adoption
        <InsightsInfo label="About adoption">
          Download reports of the chosen bundle in each interval from the hour
          it was deployed, and their running total. Downloads count reports, not
          distinct installations: an installation that downloads the bundle
          again counts again. A bundle deployed before the period counts only
          the period&apos;s downloads.
        </InsightsInfo>
      </div>
      {adoption ? (
        <p className="text-xs text-muted-foreground">
          {intervalLabel(adoption.intervalMs)} · cumulative downloads · UTC
        </p>
      ) : null}
    </div>
  );
  if (adoption === null) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {header}
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyTitle>Choose a bundle</EmptyTitle>
            <EmptyDescription>
              Pick a bundle in the filters to see how quickly it spreads after
              it is deployed.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  const total = adoption.points.at(-1)?.totalDownloads ?? 0;
  // Each running total is reached at its interval's end, the current one
  // when it was measured; the curve starts from zero where the first one starts.
  const first = adoption.points[0];
  const curve =
    first === undefined
      ? []
      : [
          { atMs: first.startMs, downloads: 0, totalDownloads: 0 },
          ...adoption.points.map((point) => ({
            atMs: Math.min(
              point.startMs + adoption.intervalMs,
              report.measuredAtMs,
            ),
            downloads: point.downloads,
            totalDownloads: point.totalDownloads,
          })),
        ];
  const deployedBefore =
    adoption.deployedAtMs !== null && adoption.deployedAtMs < report.startMs;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {total > 0 ? (
        <>
          <ChartContainer
            aria-label="Cumulative downloads of the chosen bundle"
            className="h-64 w-full aspect-auto"
            config={{
              totalDownloads: {
                label: "Cumulative downloads",
                color: "var(--chart-2)",
              },
            }}
          >
            <LineChart
              accessibilityLayer
              data={curve}
              margin={{ left: -12, right: 12, top: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="atMs"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(value) => times.format(value)}
                axisLine={false}
                tickLine={false}
                minTickGap={32}
              />
              <YAxis allowDecimals={false} axisLine={false} tickLine={false} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const point = payload[0]?.payload;
                      return point ? `${times.format(point.atMs)} UTC` : "";
                    }}
                    formatter={(value, _, item) => (
                      <div className="flex flex-1 flex-col gap-1">
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-muted-foreground">
                            Cumulative downloads
                          </span>
                          <span className="font-medium tabular-nums">
                            {Number(value).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-muted-foreground">
                            Since the previous point
                          </span>
                          <span className="font-medium tabular-nums">
                            {item.payload.downloads.toLocaleString()}
                          </span>
                        </div>
                      </div>
                    )}
                  />
                }
              />
              <Line
                dataKey="totalDownloads"
                type="linear"
                stroke="var(--color-totalDownloads)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ChartContainer>
          <p className="text-xs text-muted-foreground">
            {total.toLocaleString()} downloads
            {adoption.deployedAtMs === null
              ? " in this period"
              : deployedBefore
                ? ` in this period · Deployed ${times.format(adoption.deployedAtMs)} UTC, before the period`
                : ` since deployment · Deployed ${times.format(adoption.deployedAtMs)} UTC`}
            {report.coverage.kind === "partial" ? " · Partial history" : ""}
          </p>
        </>
      ) : (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyTitle>No downloads of this bundle in this period</EmptyTitle>
            <EmptyDescription>
              Choose a longer period or refresh after an app downloads it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
