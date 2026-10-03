import { useState } from "react";
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
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { bundleDistributionChart } from "@/lib/bundle-distribution";
import type { RecoveryReport } from "@/lib/insights-recovery";

import { InsightsInfo } from "./InsightsInfo";

const DAY = 86_400_000;
const dates = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
// Both tokens keep chart lines above 3:1 against light and dark cards.
const colors = ["var(--chart-3)", "var(--chart-4)"];
const dashes = [undefined, "6 3", "2 3", "8 3 2 3"];

export function BundleDistributionChart({
  history,
  releaseId,
}: {
  readonly history: RecoveryReport["distribution"];
  readonly releaseId?: string;
}) {
  const [version, setVersion] = useState("all");
  const versions = [
    ...new Set(
      history.points.flatMap((point) =>
        point.bundles.map((row) => row.appVersion),
      ),
    ),
  ].sort();
  const selectedVersion =
    version === "all" || !versions.includes(version) ? undefined : version;
  const chart = bundleDistributionChart(history, selectedVersion, releaseId);
  const latest = chart.points.at(-1);
  const config = Object.fromEntries(
    chart.series.map((series, index) => [
      series.key,
      {
        label: series.label,
        color:
          series.id === "other" ||
          series.id === "unknown" ||
          series.id === "builtin"
            ? "var(--muted-foreground)"
            : colors[index % colors.length],
      },
    ]),
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1 text-sm font-medium">
            Observed bundle share
            <InsightsInfo label="About observed bundle share">
              Each reporting installation counts once per UTC day, on its last
              observed running bundle. Downloads stay on the running source;
              recoveries move to the fallback. Shares include built-in and
              unknown bundles, and do not measure rollout completion or all
              installed devices. The chart covers whole UTC days touched by the
              selected period. Today is still in progress. History starts with
              observations recorded after the server upgrade; earlier days are
              not backfilled. App version filters this chart only. Different
              fingerprints and rollout targets may coexist within an app
              version.
            </InsightsInfo>
          </div>
          <p className="text-xs text-muted-foreground">
            Daily · reporting installations · UTC
          </p>
        </div>
        {versions.length > 1 ? (
          <Field className="w-full sm:w-44">
            <FieldLabel htmlFor="bundle-share-version">
              Chart app version
            </FieldLabel>
            <Select
              items={Object.fromEntries([
                ["all", "All app versions"],
                ...versions.map((value) => [value, value]),
              ])}
              value={selectedVersion ?? "all"}
              onValueChange={(value) => {
                if (value !== null) setVersion(value);
              }}
            >
              <SelectTrigger
                id="bundle-share-version"
                className="min-h-11 w-full sm:min-h-9"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All app versions</SelectItem>
                  {versions.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </div>
      {chart.points.some((point) => point.total > 0) ? (
        <>
          <ChartContainer
            aria-label="Daily observed bundle share"
            className="h-64 w-full aspect-auto"
            config={config}
          >
            <LineChart
              accessibilityLayer
              data={chart.points}
              margin={{ left: -12, right: 12, top: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="startMs"
                tickFormatter={(value) => dates.format(value)}
                axisLine={false}
                tickLine={false}
                minTickGap={32}
              />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tickFormatter={(value) => `${value}%`}
                axisLine={false}
                tickLine={false}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const point = payload[0]?.payload;
                      return point
                        ? `${dates.format(point.startMs)} · UTC${point.startMs + DAY > history.measuredAtMs ? " · In progress" : ""}`
                        : "";
                    }}
                    formatter={(value, name, item) => (
                      <div className="flex flex-1 items-center justify-between gap-4">
                        <span className="text-muted-foreground">
                          {config[String(name)]?.label}
                        </span>
                        <span className="font-medium tabular-nums">
                          {Number(value).toFixed(1)}% ·{" "}
                          {item.payload.installations[
                            String(name)
                          ].toLocaleString()}{" "}
                          / {item.payload.total.toLocaleString()}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              {chart.series.map((series, index) => (
                <Line
                  key={series.id}
                  dataKey={series.key}
                  type="linear"
                  stroke={`var(--color-${series.key})`}
                  strokeWidth={2}
                  strokeDasharray={dashes[index % dashes.length]}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ChartContainer>
          <ul
            aria-label="Bundle share legend"
            className="flex flex-wrap gap-x-6 gap-y-3 text-xs"
          >
            {chart.series.map((series, index) => (
              <li
                key={series.id}
                className="flex items-center gap-2"
                title={series.id}
              >
                <svg
                  aria-hidden="true"
                  className="h-3 w-6 shrink-0"
                  viewBox="0 0 24 12"
                >
                  <line
                    x1="0"
                    y1="6"
                    x2="24"
                    y2="6"
                    stroke={config[series.key].color}
                    strokeWidth="2"
                    strokeDasharray={dashes[index % dashes.length]}
                  />
                </svg>
                <span>{series.label}</span>
                <span className="font-medium tabular-nums">
                  {latest?.[series.key] == null
                    ? "—"
                    : `${Number(latest[series.key]).toFixed(1)}%`}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {latest
              ? `${dates.format(latest.startMs)}: ${latest.total.toLocaleString()} reporting installations${latest.startMs + DAY > history.measuredAtMs ? " · Day in progress" : ""}`
              : ""}
            {history.coverage.kind === "partial" ? " · Partial history" : ""}
          </p>
        </>
      ) : (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyTitle>No bundle observations in this period</EmptyTitle>
            <EmptyDescription>
              Choose a longer period or refresh after an app reports. History
              starts after the server upgrade.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
