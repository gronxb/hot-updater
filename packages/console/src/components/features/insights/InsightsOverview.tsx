import { Link } from "@tanstack/react-router";
import {
  CircleOff,
  ListIcon,
  RotateCcw,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { InfoTooltip } from "@/components/InfoTooltip";
import { ReleaseIdDisplay } from "@/components/ReleaseIdDisplay";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ReleaseHealthInput } from "@/lib/insights-recovery";
import type { HealthChart } from "@/lib/insights-search";
import {
  CRASH_MIN_ATTEMPTS,
  CRASH_RATE_THRESHOLD,
  crashRateOf,
  MAX_ADOPTION_RELEASES,
  bundleChip,
  recommendsRollback,
} from "@/lib/release-adoption";
import {
  type ComparedRelease,
  knownReleases,
  type ReleaseHealthState,
} from "@/lib/release-adoption-api";
import { cn } from "@/lib/utils";

import {
  ComparedBundlesChart,
  formatDeployedAt,
  useSeriesColors,
} from "./ComparedBundlesChart";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsPeriodSelector } from "./InsightsPeriodSelector";
import { InsightsScope, platformLabel } from "./InsightsScope";
import { ReleaseCombobox } from "./ReleaseCombobox";
import { RollbackButton } from "./RollbackButton";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;
const lengthOf = (durationMs: number) =>
  durationMs > DAY ? `${durationMs / DAY} days` : `${durationMs / HOUR} hours`;
const cadenceOf = (intervalMs: number) =>
  intervalMs === HOUR
    ? "Hourly"
    : intervalMs === DAY
      ? "Daily"
      : `Every ${intervalMs / HOUR} hours`;

/** A bundle's crash numbers over the period, once both counts are read. */
const crashesOf = ({ release, launched, recovered }: ComparedRelease) =>
  launched === undefined || recovered === undefined
    ? undefined
    : {
        crashes: recovered.total,
        ...crashRateOf(launched.total, recovered.total),
        recommended: recommendsRollback(
          release,
          launched.total,
          recovered.total,
        ),
      };

/** A line sample for the legend: solid or dashed, in the text color. */
function LineSample({ dashed }: { readonly dashed?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-6 shrink-0"
      viewBox="0 0 24 12"
      preserveAspectRatio="none"
    >
      <line
        x1="0"
        y1="6"
        x2="24"
        y2="6"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={dashed ? "6 4" : undefined}
      />
    </svg>
  );
}

/** The counts each chart compares, named once for the table's column
 * headers and the list's terms. */
const METRICS = {
  adoption: ["Downloaded", "Launched"],
  crashes: ["Crashed", "Crash rate"],
} as const satisfies Record<HealthChart, readonly [string, string]>;

/** A bundle's counts on a chart, in the order of `METRICS`. */
function metricsOf(
  bundle: ComparedRelease,
  chart: HealthChart,
): readonly [Metric, Metric] {
  if (chart === "adoption") {
    return [
      { value: bundle.downloaded?.total.toLocaleString() ?? "—" },
      { value: bundle.launched?.total.toLocaleString() ?? "—", strong: true },
    ];
  }
  const crashes = crashesOf(bundle);
  return [
    {
      value:
        crashes === undefined ? (
          "—"
        ) : crashes.crashes === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          crashes.crashes.toLocaleString()
        ),
    },
    {
      value:
        crashes === undefined || crashes.attempts === 0 ? (
          "—"
        ) : crashes.recommended ? (
          <span className="inline-flex items-center gap-1 font-medium text-destructive">
            <TriangleAlert aria-hidden="true" className="size-3.5" />
            {percent(crashes.rate)}
            <span className="sr-only">, rollback recommended</span>
          </span>
        ) : (
          <span
            className={cn(
              crashes.attempts < CRASH_MIN_ATTEMPTS && "text-muted-foreground",
            )}
            title={
              crashes.attempts < CRASH_MIN_ATTEMPTS
                ? `Only ${crashes.attempts} installations tried it`
                : undefined
            }
          >
            {percent(crashes.rate)}
          </span>
        ),
    },
  ];
}
interface Metric {
  readonly value: ReactNode;
  /** The count the chart draws solid. */
  readonly strong?: boolean;
}

/** A bundle's line in the chart's color, as a key beside its name. */
function SeriesSwatch({
  color,
  className,
}: {
  readonly color: string;
  readonly className: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 12"
      preserveAspectRatio="none"
    >
      <line x1="0" y1="6" x2="24" y2="6" stroke={color} strokeWidth="3" />
    </svg>
  );
}

/** A compared bundle's name and badges, then where and when it was deployed. */
function ComparedBundleName({
  release,
  showPlatform,
}: {
  readonly release: ComparedRelease["release"];
  /** Whether the report mixes platforms, so its label needs its platform. */
  readonly showPlatform: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      {/* A label and its ID tail don't shrink, so on a
          phone "Disabled" moves under them instead of over. */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ReleaseIdDisplay
          releaseId={release.releaseId}
          className="min-w-0"
          label={release.label}
          platform={showPlatform ? release.platform : undefined}
        />
        {release.enabled ? null : <Badge variant="outline">Disabled</Badge>}
      </span>
      <span className="text-xs break-words text-muted-foreground">
        Deployed {formatDeployedAt(release.deployedAtMs)}
        {release.targetAppVersion ? ` · ${release.targetAppVersion}` : ""}
        {release.enabled && !release.live ? (
          <>
            {" · "}
            <span
              className="inline-flex items-center gap-1 align-middle"
              title="No device gets this bundle with the current delivery settings."
            >
              <CircleOff aria-hidden="true" className="size-3" />
              Unreachable
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}

function RemoveButton({
  release,
  className,
  onRemove,
}: {
  readonly release: ComparedRelease["release"];
  readonly className: string;
  readonly onRemove: (releaseId: string) => void;
}) {
  return (
    <Button
      aria-label={`Remove ${release.releaseId}`}
      className={className}
      variant="ghost"
      size="icon-xs"
      onClick={() => onRemove(release.releaseId)}
    >
      <X aria-hidden="true" />
    </Button>
  );
}

/**
 * Release health: how the live bundles fare after their deployment, on
 * one timeline, per interval. Adoption shows installations downloading each
 * bundle (dashed) and launching it (solid), so the gap is the restarts still
 * to come; Crashes shows them crashing back from it, and offers a rollback
 * when a bundle crashes for too many of them.
 */
export function InsightsOverview({
  input,
  chart,
  onChartChange,
  health,
  onReleasesChange,
  onWindowChange,
  onShowAllPlatforms,
}: {
  readonly input: ReleaseHealthInput;
  readonly chart: HealthChart;
  readonly onChartChange: (chart: HealthChart) => void;
  readonly health: ReleaseHealthState;
  /** Chooses the bundles to compare; undefined returns to the default. */
  readonly onReleasesChange: (releaseIds?: readonly string[]) => void;
  readonly onWindowChange: (window: ReleaseHealthInput["window"]) => void;
  /** Widens the platform filter, offered when one platform has no bundles. */
  readonly onShowAllPlatforms?: () => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const { period, candidates, releases } = health;
  // A label is unique within a channel and platform: the channel is the
  // report's, but All platforms puts both platforms' v14 side by side.
  const mixed = input.platform === "all";
  const ids = (releases ?? []).map(({ release }) => release.releaseId);
  const colorOf = useSeriesColors(ids);
  const full = ids.length >= MAX_ADOPTION_RELEASES;
  const wider =
    period.durationMs < 7 * DAY
      ? "7d"
      : period.durationMs < 30 * DAY
        ? "30d"
        : null;
  const reset = health.isDefault ? null : (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onReleasesChange(undefined)}
    >
      <RotateCcw aria-hidden="true" data-icon="inline-start" />
      Show live bundles
    </Button>
  );
  // Adoption draws each bundle's launches solid and its downloads dashed;
  // Crashes draws its crashes.
  const seriesOf = (bundle: ComparedRelease) =>
    chart === "adoption" ? bundle.launched : bundle.recovered;
  const loaded = (releases ?? []).filter(
    (bundle) =>
      seriesOf(bundle) !== undefined &&
      (chart !== "adoption" || bundle.downloaded !== undefined),
  );
  const failed =
    (releases ?? []).find(({ error }) => error !== null)?.error ?? null;
  const flagged = (releases ?? []).flatMap((bundle) => {
    const crashes = crashesOf(bundle);
    return crashes?.recommended ? [{ ...bundle, ...crashes }] : [];
  });

  // Hovering or focusing a bundle's row draws its line over the others.
  const highlights = (releaseId: string) => ({
    onMouseEnter: () => setActive(releaseId),
    onMouseLeave: () => setActive(null),
    onFocus: () => setActive(releaseId),
    onBlur: () => setActive(null),
  });

  const remove = (releaseId: string) => {
    const rest = ids.filter((id) => id !== releaseId);
    onReleasesChange(rest.length === 0 ? undefined : rest);
  };

  const heading =
    chart === "adoption" ? (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1 text-sm font-medium">
          Installations downloading and launching each bundle
          <InfoTooltip label="About adoption">
            Dashed: installations that downloaded the bundle. Solid:
            installations that launched it. After a forced update the two lines
            meet.
          </InfoTooltip>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <p>
            {cadenceOf(period.intervalMs)} · last {lengthOf(period.durationMs)}{" "}
            · UTC
          </p>
          <ul aria-label="Line styles" className="flex items-center gap-3">
            <li className="flex items-center gap-1.5">
              <LineSample dashed />
              Downloaded
            </li>
            <li className="flex items-center gap-1.5">
              <LineSample />
              Launched
            </li>
          </ul>
        </div>
      </div>
    ) : (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1 text-sm font-medium">
          Crashes after each deployment
          <InfoTooltip label="About crashes">
            Installations that crashed on a bundle and rolled back. Crash rate =
            crashed ÷ (launched + crashed). A rollback is suggested at{" "}
            {percent(CRASH_RATE_THRESHOLD)} once {CRASH_MIN_ATTEMPTS}{" "}
            installations tried it.
          </InfoTooltip>
        </div>
        <p className="text-xs text-muted-foreground">
          {cadenceOf(period.intervalMs)} · last {lengthOf(period.durationMs)} ·
          UTC
        </p>
      </div>
    );

  const body = (() => {
    if (releases === undefined) {
      return health.error ? (
        <InsightsErrorAlert
          error={health.error}
          fallbackTitle="Release health unavailable"
        />
      ) : (
        <Skeleton aria-label="Loading release health" className="h-64" />
      );
    }
    if (releases.length === 0) {
      return (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyTitle>
              No bundles deployed to {input.channel} ·{" "}
              {platformLabel(input.platform)}
            </EmptyTitle>
            <EmptyDescription>
              Deploy one, or choose another channel or platform in the filters.
            </EmptyDescription>
          </EmptyHeader>
          {reset || (input.platform !== "all" && onShowAllPlatforms) ? (
            <EmptyContent className="flex-row flex-wrap justify-center">
              {input.platform !== "all" && onShowAllPlatforms ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onShowAllPlatforms}
                >
                  Show all platforms
                </Button>
              ) : null}
              {reset}
            </EmptyContent>
          ) : null}
        </Empty>
      );
    }
    if (loaded.length === 0) {
      return failed ? (
        <InsightsErrorAlert
          error={failed}
          fallbackTitle="Release health unavailable"
        />
      ) : (
        <Skeleton aria-label="Loading release health" className="h-64" />
      );
    }
    if (
      loaded.every(
        (bundle) =>
          seriesOf(bundle)!.total === 0 &&
          (chart !== "adoption" || bundle.downloaded!.total === 0),
      )
    ) {
      return chart === "adoption" ? (
        <Empty className="min-h-48">
          <EmptyHeader>
            <EmptyTitle>
              No installation downloaded or launched these bundles in the last{" "}
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
                Show {lengthOf(wider === "7d" ? 7 * DAY : 30 * DAY)}
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <Empty className="min-h-48">
          <EmptyHeader>
            <EmptyTitle>
              No crashes in the last {lengthOf(period.durationMs)}
            </EmptyTitle>
            <EmptyDescription>
              No launch of these bundles crashed and recovered.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    return (
      <ComparedBundlesChart
        period={period}
        showPlatform={mixed}
        lines={releases.map((bundle) => ({
          release: bundle.release,
          points: seriesOf(bundle)?.points,
          ...(chart === "adoption"
            ? { dashed: bundle.downloaded?.points }
            : {}),
          measuredAtMs: seriesOf(bundle)?.measuredAtMs,
        }))}
        colorOf={colorOf}
        active={active}
        names={
          chart === "adoption"
            ? { solid: "Launched", dashed: "Downloaded" }
            : { solid: "Crashed" }
        }
        label={
          chart === "adoption"
            ? "Installations downloading (dashed) and launching (solid) each bundle per interval"
            : "Crashes of each bundle per interval"
        }
      />
    );
  })();

  return (
    <section aria-label="Release health">
      <Card className="min-w-0 overflow-hidden shadow-sm">
        <CardHeader className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <CardTitle>Release health</CardTitle>
              <InsightsScope
                channel={input.channel}
                platform={input.platform}
                narrower={
                  input.releaseId
                    ? [bundleChip(input.releaseId, knownReleases(health))]
                    : []
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <InsightsPeriodSelector
                window={input.window}
                onWindowChange={onWindowChange}
              />
              <Button
                aria-label="Refresh release health"
                variant="ghost"
                size="icon-lg"
                className="max-md:size-11"
                disabled={health.isFetching}
                onClick={health.refresh}
              >
                <RotateCw
                  aria-hidden="true"
                  className={cn(
                    health.isFetching && "motion-safe:animate-spin",
                  )}
                />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent
          aria-busy={health.isFetching}
          className="flex flex-col gap-5 px-6 pb-6"
        >
          <Tabs
            value={chart}
            onValueChange={(value) => onChartChange(value as HealthChart)}
            className="gap-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <TabsList
                aria-label="Release health chart"
                className="min-h-11 sm:min-h-9"
              >
                <TabsTrigger value="adoption" className="px-3">
                  Adoption
                </TabsTrigger>
                <TabsTrigger value="crashes" className="px-3">
                  Crashes
                  {flagged.length > 0 ? (
                    <>
                      <TriangleAlert
                        aria-hidden="true"
                        className="text-destructive"
                      />
                      <span className="sr-only">, rollback recommended</span>
                    </>
                  ) : null}
                </TabsTrigger>
              </TabsList>
              {reset}
            </div>
            <TabsContent value="adoption" className="flex flex-col gap-4">
              {heading}
              {chart === "adoption" ? body : null}
            </TabsContent>
            <TabsContent value="crashes" className="flex flex-col gap-4">
              {flagged.map((bundle) => (
                <Alert key={bundle.release.releaseId} variant="destructive">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>
                    Roll back{" "}
                    <ReleaseIdDisplay
                      releaseId={bundle.release.releaseId}
                      className="text-sm"
                      label={bundle.release.label}
                      platform={mixed ? bundle.release.platform : undefined}
                    />
                  </AlertTitle>
                  <AlertDescription className="flex flex-col items-start gap-3">
                    It crashed for {percent(bundle.rate)} of the installations
                    that tried it ({bundle.crashes.toLocaleString()} of{" "}
                    {bundle.attempts.toLocaleString()}), above{" "}
                    {percent(CRASH_RATE_THRESHOLD)}.
                    <RollbackButton
                      release={bundle.release}
                      showPlatform={mixed}
                      rate={bundle.rate}
                      crashes={bundle.crashes}
                      attempts={bundle.attempts}
                      // The live bundles no longer include it once it is
                      // disabled: keep comparing the same ones.
                      onRolledBack={
                        health.isDefault
                          ? () => onReleasesChange(ids)
                          : undefined
                      }
                    />
                  </AlertDescription>
                </Alert>
              ))}
              {heading}
              {chart === "crashes" ? body : null}
            </TabsContent>
          </Tabs>
          {releases !== undefined && releases.length > 0 ? (
            <>
              {failed && loaded.length > 0 ? (
                <InsightsErrorAlert
                  error={failed}
                  fallbackTitle="Some bundles could not be read"
                />
              ) : null}
              {/* A table when the card has room for its columns; a list of
                  bundles, each with its counts under its name, when not. */}
              <div className="@container/compared">
                <ol
                  aria-label="Compared bundles"
                  className="divide-y border-y @[32rem]/compared:hidden"
                >
                  {releases.map((bundle) => {
                    const { release } = bundle;
                    const values = metricsOf(bundle, chart);
                    return (
                      <li
                        key={release.releaseId}
                        className="flex min-w-0 flex-col gap-2 py-3"
                        data-state={
                          active === release.releaseId ? "selected" : undefined
                        }
                        {...highlights(release.releaseId)}
                      >
                        <div
                          data-cell="bundle"
                          className="flex min-w-0 items-start gap-2"
                        >
                          <SeriesSwatch
                            color={colorOf(release.releaseId)}
                            className="mt-1.5 h-3 w-6 shrink-0"
                          />
                          <ComparedBundleName
                            release={release}
                            showPlatform={mixed}
                          />
                          {/* Its X sits on the name's first line; the 44 px
                              target reaches into the row's padding. */}
                          <RemoveButton
                            release={release}
                            className="-mt-2.5 -mr-3 -mb-3 ml-auto size-11 shrink-0"
                            onRemove={remove}
                          />
                        </div>
                        <dl className="grid grid-cols-2 gap-x-4 pl-8">
                          {METRICS[chart].map((name, index) => (
                            <div
                              key={name}
                              data-cell={name}
                              className="flex min-w-0 flex-col gap-0.5"
                            >
                              <dt className="text-xs text-muted-foreground">
                                {name}
                              </dt>
                              <dd
                                className={cn(
                                  "text-sm tabular-nums",
                                  values[index].strong && "font-medium",
                                )}
                              >
                                {values[index].value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </li>
                    );
                  })}
                </ol>
                <div className="hidden @[32rem]/compared:block">
                  <Table aria-label="Compared bundles">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Bundle</TableHead>
                        {METRICS[chart].map((name) => (
                          <TableHead key={name} className="text-right">
                            {name}
                          </TableHead>
                        ))}
                        <TableHead className="w-10">
                          <span className="sr-only">Remove</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {releases.map((bundle) => {
                        const { release } = bundle;
                        return (
                          <TableRow
                            key={release.releaseId}
                            data-state={
                              active === release.releaseId
                                ? "selected"
                                : undefined
                            }
                            {...highlights(release.releaseId)}
                          >
                            {/* The bundle cell takes the room left, and wraps in it. */}
                            <TableCell className="w-full max-w-0 whitespace-normal">
                              <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                                {/* Narrower on a phone, so a bundle's ID keeps more of the row. */}
                                <SeriesSwatch
                                  color={colorOf(release.releaseId)}
                                  className="h-3 w-4 shrink-0 sm:w-6"
                                />
                                <ComparedBundleName
                                  release={release}
                                  showPlatform={mixed}
                                />
                              </div>
                            </TableCell>
                            {metricsOf(bundle, chart).map(
                              ({ value, strong }, index) => (
                                <TableCell
                                  key={METRICS[chart][index]}
                                  className={cn(
                                    "text-right whitespace-nowrap tabular-nums",
                                    strong && "font-medium",
                                  )}
                                >
                                  {value}
                                </TableCell>
                              ),
                            )}
                            <TableCell>
                              <RemoveButton
                                release={release}
                                className="max-md:size-11"
                                onRemove={remove}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
              {(candidates ?? []).length > 0 ? (
                <ReleaseCombobox
                  scope={{ channel: input.channel, platform: input.platform }}
                  candidates={candidates ?? []}
                  excluded={ids}
                  disabled={full}
                  label="Add a bundle"
                  placeholder={
                    full
                      ? `Up to ${MAX_ADOPTION_RELEASES} bundles`
                      : "Add a bundle by label, ID or app version…"
                  }
                  onPick={(release) =>
                    onReleasesChange([...ids, release.releaseId])
                  }
                />
              ) : null}
            </>
          ) : null}
        </CardContent>
        <CardFooter className="flex items-center justify-end border-t px-6 py-5">
          <Link
            className={buttonVariants({
              className: "max-md:h-11",
              variant: "outline",
              size: "sm",
            })}
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
