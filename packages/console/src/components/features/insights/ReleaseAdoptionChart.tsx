import { extractTimestampFromUUIDv7 } from "@hot-updater/plugin-core";
import { isUUIDv7 } from "@hot-updater/protocol";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RecoveryInput, RecoveryReport } from "@/lib/insights-recovery";
import { adoptionWindow } from "@/lib/insights-search";

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

const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;

/**
 * Releases observed running in the period, and the chosen one, newest
 * deployment first: UUIDv7 IDs sort by their timestamp.
 */
const releaseChoices = (
  report: RecoveryReport,
  releaseId: string | undefined,
): readonly { readonly id: string; readonly label: string }[] =>
  [
    ...new Set([
      ...(releaseId === undefined ? [] : [releaseId]),
      ...report.distribution.points.flatMap((point) =>
        point.bundles.flatMap((bundle) =>
          bundle.bundleKind === "release" && bundle.releaseId !== null
            ? [bundle.releaseId]
            : [],
        ),
      ),
    ]),
  ]
    .sort((left, right) => right.localeCompare(left))
    .map((id) => ({
      id,
      label: isUUIDv7(id)
        ? `${shortId(id)} · ${times.format(extractTimestampFromUUIDv7(id))} UTC`
        : shortId(id),
    }));

/** The chosen release's downloads from its deployment, in the period. */
export function ReleaseAdoptionChart({
  report,
  releaseId,
  window,
  onReleaseChange,
  onWindowChange,
}: {
  readonly report: RecoveryReport;
  readonly releaseId?: string;
  readonly window: RecoveryInput["window"];
  readonly onReleaseChange: (releaseId: string) => void;
  readonly onWindowChange: (window: RecoveryInput["window"]) => void;
}) {
  const adoption = report.adoption;
  const choices = releaseChoices(report, releaseId);
  // The period that covers the chosen release from its deployment, or the
  // longest one when no release was observed.
  const wider =
    releaseId === undefined || choices.length === 0
      ? "30d"
      : adoptionWindow(releaseId, report.measuredAtMs);
  const order = ["24h", "7d", "30d"] as const;
  const widen =
    order.indexOf(wider) > order.indexOf(window) ? (
      <Button variant="outline" size="sm" onClick={() => onWindowChange(wider)}>
        Show{" "}
        {wider === "30d" ? "30 days" : wider === "7d" ? "7 days" : "24 hours"}
      </Button>
    ) : null;
  const picker =
    choices.length > 0 ? (
      <Field className="w-full sm:w-72">
        <FieldLabel htmlFor="adoption-bundle">Chart bundle</FieldLabel>
        <Select
          items={Object.fromEntries(
            choices.map((choice) => [choice.id, choice.label]),
          )}
          value={releaseId ?? null}
          onValueChange={(value) => {
            if (value !== null) onReleaseChange(value);
          }}
        >
          <SelectTrigger
            id="adoption-bundle"
            className="min-h-11 w-full sm:min-h-9"
          >
            <SelectValue placeholder="Choose a bundle" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {choices.map((choice) => (
                <SelectItem key={choice.id} value={choice.id}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    ) : null;
  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1 text-sm font-medium">
          Adoption
          <InsightsInfo label="About adoption">
            Download reports of the chosen bundle in each interval from the hour
            it was deployed, and their running total. Downloads count reports,
            not distinct installations: an installation that downloads the
            bundle again counts again. A bundle deployed before the period
            counts only the period&apos;s downloads. Chart bundle lists the
            releases observed in the period, newest deployment first, and also
            sets Release health&apos;s Release ID.
          </InsightsInfo>
        </div>
        <p className="text-xs text-muted-foreground">
          {adoption
            ? `${intervalLabel(adoption.intervalMs)} · cumulative downloads · UTC`
            : "Cumulative downloads from deployment · UTC"}
        </p>
      </div>
      {picker}
    </div>
  );
  if (adoption === null) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {header}
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyTitle>
              {choices.length > 0
                ? "Choose a bundle to chart"
                : "No releases observed in this period"}
            </EmptyTitle>
            <EmptyDescription>
              {choices.length > 0
                ? "See how quickly a bundle spreads after it is deployed."
                : "Releases appear here once installations report running them."}
            </EmptyDescription>
          </EmptyHeader>
          {choices[0] ? (
            <EmptyContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onReleaseChange(choices[0]!.id)}
              >
                Chart newest bundle
              </Button>
            </EmptyContent>
          ) : widen ? (
            <EmptyContent>{widen}</EmptyContent>
          ) : null}
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
          <div className="flex flex-wrap items-end justify-between gap-3">
            <p className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight tabular-nums">
                {total.toLocaleString()}
              </span>
              <span className="text-sm text-muted-foreground">
                {deployedBefore || adoption.deployedAtMs === null
                  ? "downloads in this period"
                  : "downloads since deployment"}
              </span>
            </p>
            {deployedBefore ? widen : null}
          </div>
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
            {adoption.deployedAtMs === null
              ? "Deployment time unknown"
              : `Deployed ${times.format(adoption.deployedAtMs)} UTC${deployedBefore ? ", before this period" : ""}`}
            {report.coverage.kind === "partial" ? " · Partial history" : ""}
          </p>
        </>
      ) : (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyTitle>No downloads of this bundle in this period</EmptyTitle>
            <EmptyDescription>
              {widen
                ? "It was deployed before this period. Show a longer one to see its downloads."
                : "Refresh after an app downloads it."}
            </EmptyDescription>
          </EmptyHeader>
          {widen ? <EmptyContent>{widen}</EmptyContent> : null}
        </Empty>
      )}
    </div>
  );
}
