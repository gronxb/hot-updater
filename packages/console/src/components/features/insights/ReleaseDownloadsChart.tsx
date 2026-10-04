import { RotateCcw, X } from "lucide-react";
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RecoveryInput } from "@/lib/insights-recovery";
import {
  DEFAULT_DOWNLOADS_RELEASES,
  type DownloadsRelease,
  MAX_DOWNLOADS_RELEASES,
} from "@/lib/release-downloads";
import type { ReleaseDownloadsState } from "@/lib/release-downloads-api";
import { cn } from "@/lib/utils";

import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsInfo } from "./InsightsInfo";

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
// The newest bundle carries the accent; older ones stay apart by dash and
// tone. These tokens keep chart lines above 3:1 against light and dark cards.
const strokes = ["var(--chart-3)", "var(--muted-foreground)", "var(--chart-4)"];
const dashes = ["6 3", "2 3", "8 3 2 3"];
const strokeOf = (index: number) =>
  index === 0 ? strokes[0] : strokes[1 + ((index - 1) % 2)];
const dashOf = (index: number) =>
  index === 0 ? undefined : dashes[(index - 1) % dashes.length];

const periods = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const cadenceOf = (intervalMs: number) =>
  intervalMs === HOUR
    ? "Hourly"
    : intervalMs === DAY
      ? "Daily"
      : `Every ${intervalMs / HOUR} hours`;
const lengthOf = (durationMs: number) =>
  durationMs % DAY === 0 && durationMs > DAY
    ? `${durationMs / DAY} days`
    : `${durationMs / HOUR} hours`;
const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;
const nameOf = (release: DownloadsRelease) =>
  release.message?.trim() || shortId(release.releaseId);
const optionOf = (release: DownloadsRelease) =>
  `${nameOf(release)} · ${times.format(release.deployedAtMs)} UTC`;

export type ReleaseDownloadsProps = Omit<
  ReleaseDownloadsState,
  "isFetching" | "refresh"
> & {
  /** Chooses the bundles to compare; undefined returns to the newest. */
  readonly onReleasesChange: (releaseIds?: readonly string[]) => void;
};

/**
 * Each chosen bundle's download reports per interval over the period, on one
 * timeline: a new bundle's downloads rise after its deployment while the one
 * it replaced stops being downloaded.
 */
export function ReleaseDownloadsChart({
  period,
  candidates,
  releases,
  isDefault,
  error,
  onReleasesChange,
  onWindowChange,
}: ReleaseDownloadsProps & {
  readonly onWindowChange: (window: RecoveryInput["window"]) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const header = (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-sm font-medium">
        Downloads by bundle
        <InsightsInfo label="About downloads by bundle">
          Download reports of each bundle in each interval of the period. After
          a new bundle is deployed, its downloads rise and the bundle it
          replaced stops being downloaded; a rollout to part of the
          installations keeps both. Bundle share answers a different question:
          which bundle reporting installations run each day. Downloads count
          reports, not distinct installations.
        </InsightsInfo>
      </div>
      <p className="text-xs text-muted-foreground">
        {cadenceOf(period.intervalMs)} · last {lengthOf(period.durationMs)} ·
        UTC
      </p>
    </div>
  );
  const newest = isDefault ? null : (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onReleasesChange(undefined)}
    >
      <RotateCcw aria-hidden="true" data-icon="inline-start" />
      Show the newest {DEFAULT_DOWNLOADS_RELEASES}
    </Button>
  );
  if (releases === undefined) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {header}
        {error ? (
          <InsightsErrorAlert
            error={error}
            fallbackTitle="Downloads unavailable"
          />
        ) : (
          <Skeleton aria-label="Loading downloads" className="h-64" />
        )}
      </div>
    );
  }
  if (releases.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {header}
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyTitle>No bundles deployed here yet</EmptyTitle>
            <EmptyDescription>
              This chart compares bundle deployments of the selected channel and
              health platform. Deploy one, or choose another in the filters.
            </EmptyDescription>
          </EmptyHeader>
          {newest ? <EmptyContent>{newest}</EmptyContent> : null}
        </Empty>
      </div>
    );
  }
  const ids = releases.map(({ release }) => release.releaseId);
  const addable = (candidates ?? []).filter(
    (candidate) => !ids.includes(candidate.releaseId),
  );
  const wider =
    period.durationMs < 7 * DAY
      ? "7d"
      : period.durationMs < 30 * DAY
        ? "30d"
        : null;
  const measuredAtMs = Math.max(
    0,
    ...releases.map(({ series }) => series?.measuredAtMs ?? 0),
  );
  const loaded = releases.filter(({ series }) => series !== undefined);
  const failed = releases.find(({ error }) => error !== null)?.error ?? null;
  const partial = releases.some(
    ({ series }) => series?.coverage.kind === "partial",
  );
  // Every interval of the period; a line starts with the interval its bundle
  // was deployed in.
  const curve = Array.from(
    { length: Math.round(period.durationMs / period.intervalMs) },
    (_, interval) => {
      const startMs = period.startMs + interval * period.intervalMs;
      return Object.fromEntries([
        ["startMs", startMs],
        ...releases.map(({ release, series }, index) => [
          `r${index}`,
          series === undefined ||
          startMs + period.intervalMs <= release.deployedAtMs
            ? null
            : (series.points.find((point) => point.startMs === startMs)
                ?.downloads ?? 0),
        ]),
      ]);
    },
  );
  const config = Object.fromEntries(
    releases.map(({ release }, index) => [
      `r${index}`,
      { label: nameOf(release), color: strokeOf(index) },
    ]),
  );
  const remove = (releaseId: string) => {
    const rest = ids.filter((id) => id !== releaseId);
    onReleasesChange(rest.length === 0 ? undefined : rest);
  };
  const full = ids.length >= MAX_DOWNLOADS_RELEASES;
  // Ticks on interval starts, a whole step apart: every 4 hours of a day,
  // every day of a week, every 5 days of a month.
  const every =
    period.intervalMs === HOUR || period.intervalMs === 6 * HOUR
      ? 4
      : period.intervalMs === DAY
        ? 5
        : Math.ceil(curve.length / 6);
  const ticks = curve
    .filter((_, interval) => interval % every === 0)
    .map((point) => point.startMs as number);
  const tick = (value: number) =>
    period.intervalMs >= 6 * HOUR ? dates.format(value) : times.format(value);
  const label = (value: number) =>
    period.intervalMs >= DAY
      ? dates.format(value)
      : `${times.format(value)} UTC`;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {header}
        {newest}
      </div>
      {failed ? (
        <InsightsErrorAlert
          error={failed}
          fallbackTitle="Downloads unavailable"
        />
      ) : null}
      {loaded.length < releases.length && loaded.length === 0 ? (
        <Skeleton aria-label="Loading downloads" className="h-64" />
      ) : loaded.some(({ series }) => series!.totalDownloads > 0) ? (
        <ChartContainer
          aria-label="Downloads of each bundle per interval"
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
              dataKey="startMs"
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
                      ? `${label(point.startMs)}${point.startMs + period.intervalMs > measuredAtMs ? " · In progress" : ""}`
                      : "";
                  }}
                />
              }
            />
            {releases.map(({ release }, index) =>
              release.deployedAtMs >= period.startMs ? (
                <ReferenceLine
                  key={`deployed-${release.releaseId}`}
                  x={release.deployedAtMs}
                  stroke={strokeOf(index)}
                  strokeDasharray="2 4"
                  strokeOpacity={0.6}
                  ifOverflow="extendDomain"
                />
              ) : null,
            )}
            {releases.map(({ release }, index) => (
              <Line
                key={release.releaseId}
                dataKey={`r${index}`}
                type="linear"
                stroke={`var(--color-r${index})`}
                strokeWidth={
                  index === 0 || active === release.releaseId ? 3 : 2
                }
                strokeDasharray={dashOf(index)}
                strokeOpacity={
                  active === null || active === release.releaseId ? 1 : 0.25
                }
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      ) : (
        <Empty className="min-h-48">
          <EmptyHeader>
            <EmptyTitle>
              No downloads of these bundles in the last{" "}
              {lengthOf(period.durationMs)}
            </EmptyTitle>
            <EmptyDescription>
              {wider
                ? "Choose a longer period, or refresh after apps download them."
                : "Refresh after apps download them."}
            </EmptyDescription>
          </EmptyHeader>
          {wider ? (
            <EmptyContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onWindowChange(wider)}
              >
                Show {periods[wider]}
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      )}
      <Table aria-label="Compared bundles">
        <TableHeader>
          <TableRow>
            <TableHead>Bundle</TableHead>
            <TableHead className="text-right">Downloads</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Remove</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {releases.map(({ release, series }, index) => (
            <TableRow
              key={release.releaseId}
              data-state={active === release.releaseId ? "selected" : undefined}
              onMouseEnter={() => setActive(release.releaseId)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(release.releaseId)}
              onBlur={() => setActive(null)}
            >
              {/* The bundle cell takes the room left, and truncates in it. */}
              <TableCell className="w-full max-w-0">
                <div className="flex min-w-0 items-center gap-3">
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
                      stroke={strokeOf(index)}
                      strokeWidth={index === 0 ? 3 : 2}
                      strokeDasharray={dashOf(index)}
                    />
                  </svg>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate" title={release.releaseId}>
                      {nameOf(release)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      Deployed {times.format(release.deployedAtMs)} UTC
                      {release.targetAppVersion
                        ? ` · ${release.targetAppVersion}`
                        : ""}
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-medium whitespace-nowrap tabular-nums",
                  (series?.totalDownloads ?? 0) === 0 &&
                    "text-muted-foreground",
                )}
              >
                {series === undefined
                  ? "—"
                  : series.totalDownloads.toLocaleString()}
              </TableCell>
              <TableCell>
                <Button
                  aria-label={`Remove ${nameOf(release)}`}
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => remove(release.releaseId)}
                >
                  <X aria-hidden="true" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {addable.length > 0 ? (
          <Select
            items={Object.fromEntries(
              addable.map((candidate) => [
                candidate.releaseId,
                optionOf(candidate),
              ]),
            )}
            value={null}
            disabled={full}
            onValueChange={(value) => {
              if (value !== null) onReleasesChange([...ids, value]);
            }}
          >
            <SelectTrigger
              aria-label="Add a bundle"
              className="min-h-11 w-full sm:min-h-9 sm:w-80"
            >
              <SelectValue
                placeholder={
                  full
                    ? `Up to ${MAX_DOWNLOADS_RELEASES} bundles`
                    : "Add a bundle"
                }
              />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {addable.map((candidate) => (
                  <SelectItem
                    key={candidate.releaseId}
                    value={candidate.releaseId}
                  >
                    {optionOf(candidate)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <span />
        )}
        {partial ? (
          <span className="text-xs text-muted-foreground">Partial history</span>
        ) : null}
      </div>
    </div>
  );
}
