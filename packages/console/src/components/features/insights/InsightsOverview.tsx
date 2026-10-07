import { Link } from "@tanstack/react-router";
import { ListIcon, RotateCcw, RotateCw, TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RecoveryInput } from "@/lib/insights-recovery";
import type { AdoptionTotal, HealthChart } from "@/lib/insights-search";
import {
  type BundleEventsSeries,
  CRASH_MIN_ATTEMPTS,
  CRASH_RATE_THRESHOLD,
  crashRateOf,
  DEFAULT_ADOPTION_RELEASES,
  MAX_ADOPTION_RELEASES,
  recommendsRollback,
} from "@/lib/release-adoption";
import type {
  ComparedBundle,
  ReleaseHealthState,
} from "@/lib/release-adoption-api";
import { cn } from "@/lib/utils";

import {
  ComparedBundlesChart,
  formatDeployedAt,
  useSeriesColors,
} from "./ComparedBundlesChart";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsInfo } from "./InsightsInfo";
import { InsightsPeriodSelector } from "./InsightsPeriodSelector";
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
const crashesOf = ({ release, launched, recovered }: ComparedBundle) =>
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

/** Each interval's count, or the running total up to it. */
const totalsOf = (
  points: BundleEventsSeries["points"] | undefined,
  cumulative: boolean,
) => {
  if (points === undefined || !cumulative) return points;
  let sum = 0;
  return points.map((point) => {
    sum += point.events;
    return { ...point, events: sum };
  });
};

/**
 * Release health: how the newest bundles fare after their deployment, on
 * one timeline. Adoption shows installations launching each bundle, per
 * interval or as a running total; Crashes shows them crashing back from it,
 * and offers a rollback when a bundle crashes for too many of them.
 */
export function InsightsOverview({
  input,
  chart,
  onChartChange,
  total = "interval",
  onTotalChange,
  health,
  onReleasesChange,
  onWindowChange,
}: {
  readonly input: RecoveryInput;
  readonly chart: HealthChart;
  readonly onChartChange: (chart: HealthChart) => void;
  /** Adoption's counts: each interval's, or the running total. */
  readonly total?: AdoptionTotal;
  readonly onTotalChange?: (total: AdoptionTotal) => void;
  readonly health: ReleaseHealthState;
  /** Chooses the bundles to compare; undefined returns to the default. */
  readonly onReleasesChange: (releaseIds?: readonly string[]) => void;
  readonly onWindowChange: (window: RecoveryInput["window"]) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const { period, candidates, releases } = health;
  const ids = (releases ?? []).map(({ release }) => release.releaseId);
  const colorOf = useSeriesColors(ids);
  const addable = (candidates ?? []).filter(
    (candidate) => !ids.includes(candidate.releaseId),
  );
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
      Show the newest {DEFAULT_ADOPTION_RELEASES}
    </Button>
  );
  const seriesOf = (bundle: ComparedBundle) =>
    chart === "adoption" ? bundle.launched : bundle.recovered;
  const cumulative = chart === "adoption" && total === "cumulative";
  const loaded = (releases ?? []).filter(
    (bundle) => seriesOf(bundle) !== undefined,
  );
  const failed =
    (releases ?? []).find(({ error }) => error !== null)?.error ?? null;
  const flagged = (releases ?? []).flatMap((bundle) => {
    const crashes = crashesOf(bundle);
    return crashes?.recommended ? [{ ...bundle, ...crashes }] : [];
  });

  const remove = (releaseId: string) => {
    const rest = ids.filter((id) => id !== releaseId);
    onReleasesChange(rest.length === 0 ? undefined : rest);
  };

  const heading =
    chart === "adoption" ? (
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1 text-sm font-medium">
            Installations launching each bundle
            <InsightsInfo label="About adoption">
              Installations that reported running each bundle, once each: at its
              apply report, or at its first report on the bundle when the apply
              report never arrived. One that comes back counts again.
            </InsightsInfo>
          </div>
          <p className="text-xs text-muted-foreground">
            {cumulative ? "Running total" : cadenceOf(period.intervalMs)} · last{" "}
            {lengthOf(period.durationMs)} · UTC
          </p>
        </div>
        {onTotalChange ? (
          <Tabs
            value={total}
            onValueChange={(value) => onTotalChange(value as AdoptionTotal)}
          >
            <TabsList
              aria-label="Adoption counts"
              className="min-h-11 sm:min-h-9"
            >
              <TabsTrigger value="interval" className="px-3">
                Per interval
              </TabsTrigger>
              <TabsTrigger value="cumulative" className="px-3">
                Cumulative
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
      </div>
    ) : (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1 text-sm font-medium">
          Crashes after each deployment
          <InsightsInfo label="About crashes">
            Launches that crashed on a bundle and rolled back to the one before.
            Crash rate = crashes ÷ (launches + crashes). A rollback is suggested
            at {percent(CRASH_RATE_THRESHOLD)} once {CRASH_MIN_ATTEMPTS}{" "}
            installations tried it.
          </InsightsInfo>
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
            <EmptyTitle>No bundles deployed here yet</EmptyTitle>
            <EmptyDescription>
              Release health follows the bundle deployments of the selected
              channel and health platform. Deploy one, or choose another in the
              filters.
            </EmptyDescription>
          </EmptyHeader>
          {reset ? <EmptyContent>{reset}</EmptyContent> : null}
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
    if (loaded.every((bundle) => seriesOf(bundle)!.total === 0)) {
      return chart === "adoption" ? (
        <Empty className="min-h-48">
          <EmptyHeader>
            <EmptyTitle>
              No installation launched these bundles in the last{" "}
              {lengthOf(period.durationMs)}
            </EmptyTitle>
            <EmptyDescription>
              {wider
                ? "Choose a longer period, or refresh after apps apply them."
                : "Refresh after apps apply them."}
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
        lines={releases.map((bundle) => ({
          release: bundle.release,
          points: totalsOf(seriesOf(bundle)?.points, cumulative),
          measuredAtMs: seriesOf(bundle)?.measuredAtMs,
        }))}
        colorOf={colorOf}
        active={active}
        label={
          chart === "adoption"
            ? cumulative
              ? "Installations launching each bundle, running total"
              : "Installations launching each bundle per interval"
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
            <CardTitle>Release health</CardTitle>
            <div className="flex items-center gap-2">
              <InsightsPeriodSelector
                window={input.window}
                onWindowChange={onWindowChange}
              />
              <Button
                aria-label="Refresh release health"
                variant="ghost"
                size="icon-lg"
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
                    <BundleIdDisplay
                      bundleId={bundle.release.releaseId}
                      className="text-sm"
                    />
                  </AlertTitle>
                  <AlertDescription className="flex flex-col items-start gap-3">
                    It crashed for {percent(bundle.rate)} of the installations
                    that tried it ({bundle.crashes.toLocaleString()} of{" "}
                    {bundle.attempts.toLocaleString()}), above{" "}
                    {percent(CRASH_RATE_THRESHOLD)}.
                    <RollbackButton
                      release={bundle.release}
                      rate={bundle.rate}
                      crashes={bundle.crashes}
                      attempts={bundle.attempts}
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
              <Table aria-label="Compared bundles">
                <TableHeader>
                  <TableRow>
                    <TableHead>Bundle</TableHead>
                    {chart === "adoption" ? (
                      <TableHead className="text-right">Launched</TableHead>
                    ) : (
                      <>
                        <TableHead className="text-right">Crashes</TableHead>
                        <TableHead className="text-right">Crash rate</TableHead>
                      </>
                    )}
                    <TableHead className="w-10">
                      <span className="sr-only">Remove</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {releases.map((bundle) => {
                    const { release } = bundle;
                    const crashes = crashesOf(bundle);
                    return (
                      <TableRow
                        key={release.releaseId}
                        data-state={
                          active === release.releaseId ? "selected" : undefined
                        }
                        onMouseEnter={() => setActive(release.releaseId)}
                        onMouseLeave={() => setActive(null)}
                        onFocus={() => setActive(release.releaseId)}
                        onBlur={() => setActive(null)}
                      >
                        {/* The bundle cell takes the room left, and wraps in it. */}
                        <TableCell className="w-full max-w-0 whitespace-normal">
                          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                            {/* Narrower on a phone, so a bundle's ID keeps more of the row. */}
                            <svg
                              aria-hidden="true"
                              className="h-3 w-4 shrink-0 sm:w-6"
                              viewBox="0 0 24 12"
                              preserveAspectRatio="none"
                            >
                              <line
                                x1="0"
                                y1="6"
                                x2="24"
                                y2="6"
                                stroke={colorOf(release.releaseId)}
                                strokeWidth="3"
                              />
                            </svg>
                            <div className="flex min-w-0 flex-col">
                              <span className="flex min-w-0 items-center gap-2">
                                <BundleIdDisplay
                                  bundleId={release.releaseId}
                                  className="min-w-0"
                                />
                                {release.enabled ? null : (
                                  <Badge variant="outline">Disabled</Badge>
                                )}
                              </span>
                              <span className="text-xs break-words text-muted-foreground">
                                Deployed{" "}
                                {formatDeployedAt(release.deployedAtMs)}
                                {release.targetAppVersion
                                  ? ` · ${release.targetAppVersion}`
                                  : ""}
                              </span>
                            </div>
                          </div>
                        </TableCell>
                        {chart === "adoption" ? (
                          <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                            {bundle.launched?.total.toLocaleString() ?? "—"}
                          </TableCell>
                        ) : (
                          <>
                            <TableCell className="text-right whitespace-nowrap tabular-nums">
                              {crashes === undefined ? (
                                "—"
                              ) : crashes.crashes === 0 ? (
                                <span className="text-muted-foreground">0</span>
                              ) : (
                                crashes.crashes.toLocaleString()
                              )}
                            </TableCell>
                            <TableCell className="text-right whitespace-nowrap tabular-nums">
                              {crashes === undefined ||
                              crashes.attempts === 0 ? (
                                "—"
                              ) : crashes.recommended ? (
                                <span className="inline-flex items-center gap-1 font-medium text-destructive">
                                  <TriangleAlert
                                    aria-hidden="true"
                                    className="size-3.5"
                                  />
                                  {percent(crashes.rate)}
                                  <span className="sr-only">
                                    , rollback recommended
                                  </span>
                                </span>
                              ) : (
                                <span
                                  className={cn(
                                    crashes.attempts < CRASH_MIN_ATTEMPTS &&
                                      "text-muted-foreground",
                                  )}
                                  title={
                                    crashes.attempts < CRASH_MIN_ATTEMPTS
                                      ? `Only ${crashes.attempts} installations tried it`
                                      : undefined
                                  }
                                >
                                  {percent(crashes.rate)}
                                </span>
                              )}
                            </TableCell>
                          </>
                        )}
                        <TableCell>
                          <Button
                            aria-label={`Remove ${release.releaseId}`}
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => remove(release.releaseId)}
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {addable.length > 0 ? (
                <Select
                  items={Object.fromEntries(
                    addable.map((candidate) => [
                      candidate.releaseId,
                      `${candidate.releaseId} · ${formatDeployedAt(candidate.deployedAtMs)}`,
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
                          ? `Up to ${MAX_ADOPTION_RELEASES} bundles`
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
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <BundleIdDisplay bundleId={candidate.releaseId} />{" "}
                            <span className="text-xs text-muted-foreground">
                              Deployed{" "}
                              {formatDeployedAt(candidate.deployedAtMs)}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : null}
            </>
          ) : null}
        </CardContent>
        <CardFooter className="flex items-center justify-end border-t px-6 py-5">
          <Link
            className={buttonVariants({ variant: "outline", size: "sm" })}
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
