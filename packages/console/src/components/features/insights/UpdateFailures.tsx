import { ChevronDown, RotateCw } from "lucide-react";
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

import { EstimatedCount } from "./EstimatedCount";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsInfo } from "./InsightsInfo";

const share = (events: number, total: number) =>
  total === 0 ? "—" : `${((events / total) * 100).toFixed(1)}%`;

function Metric({
  label,
  info,
  children,
}: {
  readonly label: string;
  readonly info?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="flex items-center gap-1 text-sm text-muted-foreground">
        {label}
        {info ? (
          <InsightsInfo label={`About ${label.toLowerCase()}`}>
            {info}
          </InsightsInfo>
        ) : null}
      </dt>
      <dd className="text-3xl font-semibold tracking-tight tabular-nums">
        {children}
      </dd>
    </div>
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
    <TableRow className="[&>td]:px-4 [&>td]:py-3 [&>td]:align-top sm:[&>td]:px-6">
      <TableCell className="whitespace-normal">
        <details className="group/failure">
          <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
            <span className="font-medium">{label}</span>
            <ChevronDown
              aria-hidden="true"
              className="size-3 text-muted-foreground group-open/failure:rotate-180"
            />
          </summary>
          <ul
            aria-label={`${label} details`}
            className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground"
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
                  <span className="tabular-nums">
                    {detail.events.toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {failure.events.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {share(failure.events, total)}
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

function FailuresReport({ report }: { readonly report: UpdateFailuresReport }) {
  const breakdown = report.breakdown ?? [];
  const total = breakdown.reduce((sum, { events }) => sum + events, 0);
  return (
    <div className="flex flex-col gap-8">
      <dl className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        <Metric label="Failed updates">
          {report.failedUpdates.toLocaleString()}
        </Metric>
        <Metric
          label="Failure rate"
          info="Installations with a failed download or install, divided by those plus download reports: each installation reports a bundle's download once. Installations are estimated."
        >
          {formatRate(failureRate(report))}
        </Metric>
        <Metric
          label="Failed installations"
          info="Distinct installations with a failed download or install, estimated: typically within about 3%. A client reports each failure at most once a UTC day."
        >
          <EstimatedCount value={report.failedInstallations} />
        </Metric>
        <Metric
          label="Patch fallback rate"
          info="Of the downloads that tried a patch, the share that fell back to the changed files or the full archive."
        >
          {formatRate(patchFallbackRate(report))}
        </Metric>
        {report.checks ? (
          <>
            <Metric label="Failed checks">
              {report.checks.failures.toLocaleString()}
            </Metric>
            <Metric
              label="Check failure rate"
              info="Installations whose update check failed, divided by the channel's active installations; both estimated. A check the device could not send while offline is not reported."
            >
              {formatRate(checkFailureRate(report.checks))}
            </Metric>
          </>
        ) : null}
      </dl>
      <section
        aria-labelledby="failures-by-stage"
        className="flex flex-col gap-2"
      >
        <h3 className="text-sm font-medium" id="failures-by-stage">
          Failures by stage and reason
        </h3>
        {breakdown.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No update failures in this period.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="[&>th]:px-4 sm:[&>th]:px-6">
                <TableHead>Stage · reason</TableHead>
                <TableHead className="w-24 text-right">Reports</TableHead>
                <TableHead className="w-24 text-right">Share</TableHead>
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
      {report.recoveries ? <Recoveries recoveries={report.recoveries} /> : null}
    </div>
  );
}

/**
 * Update failures for Release health's scope and period: counts, rates, the
 * stage and reason breakdown with what else the clients knew, and why
 * crashed processes exited.
 */
export function UpdateFailures({
  query,
  onRefresh,
}: {
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
        <CardHeader className="flex flex-col gap-1.5 p-6">
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
            Checks, downloads, and installs that failed, for Release health's
            scope and period.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          {query.isPending ? (
            <Skeleton aria-label="Loading update failures" className="h-64" />
          ) : query.error ? (
            <InsightsErrorAlert
              error={query.error}
              fallbackTitle="Update failures unavailable"
            />
          ) : query.data ? (
            <FailuresReport report={query.data} />
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
