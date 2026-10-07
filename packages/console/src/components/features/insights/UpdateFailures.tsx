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
  type UpdateFailuresReport,
} from "@/lib/insights-failures";
import { cn } from "@/lib/utils";

import { EstimatedCount } from "./EstimatedCount";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsInfo } from "./InsightsInfo";

const share = (events: number, total: number) =>
  total === 0 ? "—" : `${((events / total) * 100).toFixed(1)}%`;

/**
 * One kind of failure: its rate as the headline, then how many failures and
 * installations it holds.
 */
function FailureSummary({
  id,
  title,
  info,
  rate,
  of,
  failures,
  installations,
  previous,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly info: string;
  readonly rate: number | null;
  /** What the rate is a share of. */
  readonly of: string;
  readonly failures: number;
  readonly installations: number;
  readonly previous?: {
    readonly rate: number | null;
    readonly complete: boolean;
  };
  readonly children?: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-1">
      <h3
        id={id}
        className="flex min-h-11 items-center gap-1 text-sm font-medium sm:min-h-7"
      >
        {title}
        <InsightsInfo label={`About ${title.toLowerCase()}`}>
          {info}
        </InsightsInfo>
      </h3>
      <p className="text-3xl font-semibold tracking-tight tabular-nums">
        <Rate value={rate} />
      </p>
      <p className="text-xs text-muted-foreground">{of}</p>
      {previous ? (
        <RateChange
          value={rate}
          previous={previous.rate}
          complete={previous.complete}
        />
      ) : null}
      <p className="mt-2 text-sm text-muted-foreground tabular-nums">
        {failures.toLocaleString()} {failures === 1 ? "failure" : "failures"}
        {" · "}
        <EstimatedCount value={installations} />{" "}
        {installations === 1 ? "installation" : "installations"}
      </p>
      {children}
    </section>
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
  // No change to show before a whole previous period was recorded.
  if (!complete || value === null || previous === null) return null;
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

function FailuresReport({
  report,
  errors,
}: {
  readonly report: UpdateFailuresReport;
  readonly errors?: ReactNode;
}) {
  const breakdown = report.breakdown ?? [];
  const total = breakdown.reduce((sum, { events }) => sum + events, 0);
  const unreasoned = breakdown
    .filter(({ reason }) => reason === "unknown")
    .reduce((sum, { events }) => sum + events, 0);
  const patchAttempts = report.patchDownloads + report.patchFallbacks;
  return (
    <div className="flex flex-col gap-8">
      <div className={cn("grid gap-6", report.checks && "sm:grid-cols-2")}>
        <FailureSummary
          id="download-install-failures"
          title="Downloads & installs"
          info="Failed downloads and installs ÷ those plus successful downloads."
          rate={failureRate(report)}
          of="of update attempts failed"
          failures={report.failedUpdates}
          installations={report.failedInstallations}
          previous={
            report.previous && {
              rate: report.previous.attemptRate,
              complete: report.previous.complete,
            }
          }
        >
          {patchAttempts > 0 ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              {report.patchFallbacks.toLocaleString()} of{" "}
              {patchAttempts.toLocaleString()} patch downloads fell back to the
              full archive
            </p>
          ) : null}
        </FailureSummary>
        {report.checks ? (
          <FailureSummary
            id="update-check-failures"
            title="Update checks"
            info="Installations whose update check failed ÷ active installations. A check that fails offline isn't reported."
            rate={checkFailureRate(report.checks)}
            of="of active installations had a check fail"
            failures={report.checks.failures}
            installations={report.checks.failedInstallations}
            previous={
              report.previous && {
                rate: report.previous.checkRate,
                complete: report.previous.complete,
              }
            }
          />
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
        {unreasoned * 2 > total ? (
          <p className="text-sm text-muted-foreground">
            Most report no reason: an SDK that doesn&apos;t classify failures
            reports every failed check, offline ones included.
          </p>
        ) : null}
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
    </div>
  );
}

/**
 * Update failures for Release health's scope and period: counts, rates, and
 * the stage and reason breakdown with what else the clients knew.
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
