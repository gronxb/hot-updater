import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { AdoptionRelease } from "@/lib/release-adoption";
import type { ReleaseHealthState } from "@/lib/release-adoption-api";

type DotProps = {
  readonly cx?: number;
  readonly cy?: number;
  readonly index: number;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const times = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const dates = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const clock = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** One hue per compared bundle, in the validated order of `--series-*`. */
const SERIES = ["--series-1", "--series-2", "--series-3", "--series-4"];

export const formatDeployedAt = (ms: number) => `${times.format(ms)} UTC`;

/**
 * A color for each bundle that stays with it: a bundle keeps its hue while
 * others are added or removed, and a new one takes the first free hue.
 */
export function useSeriesColors(releaseIds: readonly string[]) {
  const [slots] = useState(() => new Map<string, number>());
  // Recomputing from the same ids gives the same slots, so this stays pure
  // enough to run twice.
  // A Map allows deleting the entry being visited.
  for (const releaseId of slots.keys())
    if (!releaseIds.includes(releaseId)) slots.delete(releaseId);
  for (const releaseId of releaseIds) {
    if (slots.has(releaseId)) continue;
    const used = new Set(slots.values());
    let slot = 0;
    while (used.has(slot)) slot += 1;
    slots.set(releaseId, slot);
  }
  return (releaseId: string) =>
    `var(${SERIES[(slots.get(releaseId) ?? 0) % SERIES.length]})`;
}

type Period = ReleaseHealthState["period"];

type ChartLine = {
  readonly release: AdoptionRelease;
  readonly points:
    | readonly { readonly startMs: number; readonly events: number }[]
    | undefined;
  readonly measuredAtMs: number | undefined;
};

/** An interval as the tooltip names it, in UTC. */
export const spanOf = (startMs: number, endMs: number) =>
  dates.format(startMs) === dates.format(endMs)
    ? `${times.format(startMs)}–${clock.format(endMs)} UTC`
    : `${times.format(startMs)} – ${times.format(endMs)} UTC`;

/**
 * One row per interval of the period, at the interval's end, with each
 * bundle's count as `b<index>`: none before the interval it was deployed in,
 * and none while its counts load.
 */
export const curveOf = (period: Period, lines: readonly ChartLine[]) =>
  Array.from(
    { length: Math.round(period.durationMs / period.intervalMs) },
    (_, interval) => {
      const startMs = period.startMs + interval * period.intervalMs;
      const endMs = startMs + period.intervalMs;
      return Object.fromEntries([
        ["startMs", startMs],
        ["endMs", endMs],
        ...lines.map(({ release, points }, index) => [
          `b${index}`,
          points === undefined || endMs <= release.deployedAtMs
            ? null
            : (points.find((point) => point.startMs === startMs)?.events ?? 0),
        ]),
      ]) as { startMs: number; endMs: number } & Record<string, number | null>;
    },
  );

/**
 * Ticks on whole UTC times between the first count and the period's end, so
 * a date names its midnight: every 4 hours of a day, each midnight of a week,
 * every fifth midnight of a month.
 */
export const ticksOf = (period: Period) => {
  const step =
    period.intervalMs === HOUR
      ? 4 * HOUR
      : period.intervalMs === 6 * HOUR
        ? DAY
        : 5 * DAY;
  const ticks: number[] = [];
  for (
    let at = Math.ceil((period.startMs + period.intervalMs) / step) * step;
    at < period.endMs;
    at += step
  )
    ticks.push(at);
  return ticks;
};

/**
 * Each bundle's reports per interval of the period on one timeline, with its
 * deployment marked. A count sits at the end of its interval, so a line starts
 * after its deployment, with the interval it was deployed in.
 */
export function ComparedBundlesChart({
  period,
  lines,
  colorOf,
  active,
  label,
}: {
  readonly period: Period;
  readonly lines: readonly ChartLine[];
  readonly colorOf: (releaseId: string) => string;
  readonly active: string | null;
  readonly label: string;
}) {
  const measuredAtMs = Math.max(
    0,
    ...lines.map((line) => line.measuredAtMs ?? 0),
  );
  const curve = curveOf(period, lines);
  const ticks = ticksOf(period);
  const tick = (value: number) =>
    period.intervalMs === HOUR ? times.format(value) : dates.format(value);
  const config = Object.fromEntries(
    lines.map(({ release }, index) => [
      `b${index}`,
      {
        // The ID that names the bundle across the Console.
        label: (
          <BundleIdDisplay
            bundleId={release.releaseId}
            className="whitespace-nowrap"
          />
        ),
        color: colorOf(release.releaseId),
      },
    ]),
  );
  return (
    <ChartContainer
      aria-label={label}
      className="h-64 w-full aspect-auto"
      config={config}
    >
      <LineChart
        accessibilityLayer
        data={curve}
        margin={{ left: -12, right: 12, top: 8 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="endMs"
          type="number"
          domain={["dataMin", "dataMax"]}
          ticks={ticks}
          tickFormatter={tick}
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
                return point
                  ? `${spanOf(point.startMs, point.endMs)}${point.endMs > measuredAtMs ? " · In progress" : ""}`
                  : "";
              }}
            />
          }
        />
        {lines.map(({ release }) =>
          release.deployedAtMs >= period.startMs ? (
            <ReferenceLine
              key={`deployed-${release.releaseId}`}
              x={release.deployedAtMs}
              stroke={colorOf(release.releaseId)}
              strokeOpacity={0.5}
              ifOverflow="extendDomain"
            />
          ) : null,
        )}
        {lines.map(({ release }, index) => (
          <Line
            key={release.releaseId}
            dataKey={`b${index}`}
            type="linear"
            stroke={`var(--color-b${index})`}
            strokeWidth={active === release.releaseId ? 3 : 2}
            strokeOpacity={
              active === null || active === release.releaseId ? 1 : 0.25
            }
            // A point with no neighbour, as the first hour after a
            // deployment, draws no line: mark it.
            dot={({ cx, cy, index: at }: DotProps) => {
              const key = `b${index}`;
              const value = curve[at]?.[key];
              return value == null ||
                cx == null ||
                cy == null ||
                curve[at - 1]?.[key] != null ||
                curve[at + 1]?.[key] != null ? (
                <g key={`${key}-${at}`} />
              ) : (
                <circle
                  key={`${key}-${at}`}
                  cx={cx}
                  cy={cy}
                  r={4}
                  fill={colorOf(release.releaseId)}
                />
              );
            }}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
