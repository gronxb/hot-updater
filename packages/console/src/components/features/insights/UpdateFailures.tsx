import { ChevronRight, RotateCw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  checkFailureRate,
  failureDetailParts,
  failureRate,
  failureReasonLabel,
  failureStageLabel,
  formatRate,
  type InsightsFailureBreakdown,
  patchFallbackRate,
  type UpdateFailuresReport,
} from "@/lib/insights-failures";
import { cn } from "@/lib/utils";

import { EstimatedCount } from "./EstimatedCount";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsInfo } from "./InsightsInfo";

const share = (events: number, total: number) =>
  total === 0 ? "—" : `${((events / total) * 100).toFixed(1)}%`;

function Metric({
  label,
  info,
  attention = false,
  children,
}: {
  readonly label: string;
  readonly info?: ReactNode;
  readonly attention?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="flex min-h-11 items-center gap-1 text-xs text-muted-foreground sm:min-h-7">
        {label}
        {info ? (
          <InsightsInfo label={`About ${label.toLowerCase()}`}>
            {info}
          </InsightsInfo>
        ) : null}
      </dt>
      <dd
        className={cn(
          "text-2xl font-semibold tracking-tight tabular-nums",
          attention && "text-warning",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function Rate({ value }: { readonly value: number | null }) {
  const formatted = formatRate(value);
  return value === null ? (
    formatted
  ) : (
    <>
      {formatted.slice(0, -1)}
      <span className="ml-0.5 text-sm font-normal text-muted-foreground">
        %
      </span>
    </>
  );
}

function RateChange({
  value,
  previous,
  complete,
}: {
  readonly value: number | null;
  readonly previous: number | null;
  readonly complete: boolean;
}) {
  if (!complete || value === null || previous === null) {
    return (
      <span className="mt-1 block text-xs font-normal text-muted-foreground">
        Previous period unavailable
      </span>
    );
  }
  const difference = (value - previous) * 100;
  const rounded = Number(difference.toFixed(2));
  return (
    <span
      className={cn(
        "mt-1 block text-xs font-normal",
        rounded > 0 ? "text-warning" : "text-muted-foreground",
      )}
    >
      {rounded === 0
        ? "Unchanged"
        : `${rounded > 0 ? "↑ +" : "↓ "}${rounded.toFixed(2)} pp`}{" "}
      vs previous period
    </span>
  );
}

/** One stage and reason, and what else its clients knew, most first. */
function FailureRow({
  failure,
  total,
}: {
  readonly failure: InsightsFailureBreakdown;
  readonly total: number;
}) {
  const label = `${failureStageLabel(failure.stage)} · ${failureReasonLabel(failure.reason)}`;
  return (
    <TableRow className="[&>td]:px-2 [&>td]:py-3 [&>td]:align-top sm:[&>td]:px-4">
      <TableCell className="whitespace-normal">
        <details className="group/failure">
          <summary
            aria-label={label}
            className="flex min-h-11 w-fit max-w-full cursor-pointer list-none items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
          >
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground group-open/failure:rotate-90"
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {failureStageLabel(failure.stage)}
              </span>
              <span className="text-sm font-medium wrap-anywhere">
                {failureReasonLabel(failure.reason)}
              </span>
            </span>
          </summary>
          <ul
            aria-label={`${label} details`}
            className="mt-3 flex flex-col gap-3 rounded-md border bg-muted/20 p-3 text-sm"
          >
            {failure.details.map((detail) => {
              const parts = failureDetailParts(detail);
              return (
                <li
                  key={JSON.stringify(detail)}
                  className="flex justify-between gap-4"
                >
                  <span className="wrap-anywhere">
                    {parts.length === 0
                      ? "No details reported"
                      : parts.join(" · ")}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {detail.events.toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="inline-flex min-h-11 items-center text-sm font-medium">
          {failure.events.toLocaleString()}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        <span className="inline-flex min-h-11 items-center text-sm">
          {share(failure.events, total)}
        </span>
      </TableCell>
    </TableRow>
  );
}

function Recoveries({
  recoveries,
}: {
  readonly recoveries: NonNullable<UpdateFailuresReport["recoveries"]>;
}) {
  const known = recoveries.byExitReason.reduce(
    (sum, { events }) => sum + events,
    0,
  );
  const unreported = Math.max(0, recoveries.failedLaunches - known);
  const reasons = [
    ...recoveries.byExitReason.map(({ exitReason, events }) => ({
      name: exitReason,
      code: true,
      events,
    })),
    ...(unreported > 0
      ? [{ name: "Not reported", code: false, events: unreported }]
      : []),
  ];
  return (
    <section
      aria-labelledby="recoveries-by-exit-reason"
      className="flex flex-col gap-2"
    >
      <h3
        className="flex items-center gap-1 text-sm font-medium"
        id="recoveries-by-exit-reason"
      >
        Recoveries by exit reason
        <InsightsInfo label="About exit reasons">
          Why the crashed process exited, as Android 11 and later report it: a
          crash, an ANR, or the system or the user closing the app. iOS and
          older Android report none.
        </InsightsInfo>
      </h3>
      {reasons.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No recoveries in this period.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {reasons.map(({ name, code, events }) => (
            <li key={name} className="flex justify-between gap-4">
              <span className={code ? "font-mono text-xs" : undefined}>
                {name}
              </span>
              <span className="tabular-nums">
                {events.toLocaleString()}
                <span className="ml-2 text-muted-foreground">
                  {share(events, recoveries.failedLaunches)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FailuresReport({
  report,
  errors,
}: {
  readonly report: UpdateFailuresReport;
  readonly errors?: ReactNode;
}) {
  const breakdown = report.breakdown ?? [];
  const total = breakdown.reduce((sum, { events }) => sum + events, 0);
  return (
    <div className="flex flex-col gap-8">
      <div
        className={cn("grid gap-6", report.checks && "lg:grid-cols-[2fr_1fr]")}
      >
        <section
          aria-labelledby="download-install-failures"
          className="flex min-w-0 flex-col gap-3"
        >
          <h3 id="download-install-failures" className="text-sm font-medium">
            Downloads &amp; installs
          </h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <Metric label="Failed updates" attention={report.failedUpdates > 0}>
              {report.failedUpdates.toLocaleString()}
            </Metric>
            <Metric
              label="Attempt failure rate"
              attention={report.failedUpdates > 0}
              info="The failure rate of update attempts: failed download and install reports divided by those plus download reports."
            >
              <Rate value={failureRate(report)} />
              {report.previous ? (
                <RateChange
                  value={failureRate(report)}
                  previous={report.previous.attemptRate}
                  complete={report.previous.complete}
                />
              ) : null}
            </Metric>
            <Metric
              label="Failed installations"
              attention={report.failedInstallations > 0}
              info="Distinct installations with a failed download or install, estimated: typically within about 3%. A client reports each failure at most once a UTC day."
            >
              <EstimatedCount value={report.failedInstallations} />
            </Metric>
            <Metric
              label="Patch fallback rate"
              info="Of the downloads that tried a patch, the share that fell back to the changed files or the full archive."
            >
              <Rate value={patchFallbackRate(report)} />
            </Metric>
          </dl>
        </section>
        {report.checks ? (
          <section
            aria-labelledby="update-check-failures"
            className="flex min-w-0 flex-col gap-3 rounded-lg bg-muted/30 p-4 lg:p-6"
          >
            <h3 id="update-check-failures" className="text-sm font-medium">
              Update checks
            </h3>
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-1">
              <Metric
                label="Failed checks"
                attention={report.checks.failures > 0}
              >
                {report.checks.failures.toLocaleString()}
              </Metric>
              <Metric
                label="Check failure rate"
                attention={report.checks.failedInstallations > 0}
                info="Installations whose update check failed, divided by the channel's active installations; both estimated. A check the device could not send while offline is not reported."
              >
                <Rate value={checkFailureRate(report.checks)} />
                {report.previous ? (
                  <RateChange
                    value={checkFailureRate(report.checks)}
                    previous={report.previous.checkRate}
                    complete={report.previous.complete}
                  />
                ) : null}
              </Metric>
            </dl>
          </section>
        ) : null}
      </div>
      <Separator />
      {errors ? (
        <>
          {errors}
          <Separator />
        </>
      ) : null}
      <section
        aria-labelledby="failures-by-stage"
        className="flex flex-col gap-3"
      >
        <h3 className="text-sm font-medium" id="failures-by-stage">
          Failures by stage and reason
        </h3>
        {breakdown.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No update failures in this period.
          </p>
        ) : (
          <Table aria-label="Failures by stage and reason">
            <TableHeader>
              <TableRow className="[&>th]:px-2 sm:[&>th]:px-4">
                <TableHead>Stage / reason</TableHead>
                <TableHead className="w-16 text-right sm:w-24">
                  Reports
                </TableHead>
                <TableHead className="w-16 text-right sm:w-24">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {breakdown.map((failure) => (
                <FailureRow
                  key={`${failure.stage} ${failure.reason}`}
                  failure={failure}
                  total={total}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      {report.recoveries ? (
        <>
          <Separator />
          <Recoveries recoveries={report.recoveries} />
        </>
      ) : null}
    </div>
  );
}

/**
 * Update failures for Release health's scope and period: counts, rates, the
 * stage and reason breakdown with what else the clients knew, and why
 * crashed processes exited.
 */
export function UpdateFailures({
  errors,
  query,
  onRefresh,
}: {
  readonly errors?: ReactNode;
  readonly query: {
    readonly data: UpdateFailuresReport | undefined;
    readonly error: Error | null;
    readonly isPending: boolean;
    readonly isFetching: boolean;
  };
  readonly onRefresh: () => void;
}) {
  return (
    <section aria-label="Update failures">
      <Card className="min-w-0 overflow-hidden shadow-sm">
        <CardHeader className="flex flex-col gap-1.5 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <CardTitle>Update failures</CardTitle>
            <Button
              aria-label="Refresh update failures"
              variant="ghost"
              size="icon-lg"
              disabled={query.isFetching}
              onClick={onRefresh}
            >
              <RotateCw aria-hidden="true" />
            </Button>
          </div>
          <CardDescription>
            Track failure rates, inspect original errors, and open individual
            reports in the selected Release health scope and period.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 sm:px-6 sm:pb-6">
          {query.isPending ? (
            <Skeleton aria-label="Loading update failures" className="h-64" />
          ) : query.error ? (
            <InsightsErrorAlert
              error={query.error}
              fallbackTitle="Update failures unavailable"
            />
          ) : query.data ? (
            <FailuresReport report={query.data} errors={errors} />
          ) : null}
        </CardContent>
        {query.data?.coverage.kind === "partial" ? (
          <CardFooter className="border-t px-6 py-5">
            <span className="text-xs text-muted-foreground">Partial</span>
          </CardFooter>
        ) : null}
      </Card>
    </section>
  );
}
