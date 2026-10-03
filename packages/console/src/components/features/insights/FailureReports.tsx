import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFailureReportsQuery } from "@/lib/insights-api";
import {
  groupFailureReports,
  type FailureGroup,
  type FailureReportsInput,
  type FailureReportsPage,
} from "@/lib/insights-errors";
import {
  failureDetailParts,
  failureReasonLabel,
  failureStageLabel,
} from "@/lib/insights-failures";
import type { InsightsEventRow } from "@/lib/insights-view";

import {
  EventBundleTransition,
  EventTimestamp,
  useInsightsTimeFormat,
} from "./EventDetails";
import { InsightsErrorAlert } from "./InsightsErrorAlert";

const messageOf = (event: InsightsEventRow) =>
  event.failure?.errorMessage || "No error message reported";

function FailureDetail({ group }: { readonly group: FailureGroup }) {
  const [selectedId, setSelectedId] = useState(group.reports[0]!.id);
  const event =
    group.reports.find(({ id }) => id === selectedId) ?? group.reports[0]!;
  const failure = event.failure!;
  const formatter = useInsightsTimeFormat();
  const context = [
    [
      "App",
      `${event.platform === "ios" ? "iOS" : "Android"} ${event.appVersion}`,
    ],
    ["Channel", event.channel],
    ["SDK", event.sdkVersion ?? "Not reported"],
    ["Stage", failureStageLabel(failure.stage)],
    ["Resource", failure.resource],
    ["HTTP status", failure.httpStatus?.toString()],
    ["Origin code", failure.originCode],
    ["Transport", failure.transport],
  ].filter(([, value]) => value !== undefined);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(event, null, 2));
      toast.success("Error report copied");
    } catch {
      toast.error("Could not copy the report");
    }
  };
  return (
    <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
      <SheetHeader className="border-b pr-14">
        <SheetTitle>Error details</SheetTitle>
        <SheetDescription>
          {group.reports.length.toLocaleString()} loaded reports ·{" "}
          {group.installations.toLocaleString()} installations
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
        <section
          aria-label="Original error"
          className="flex min-w-0 flex-col gap-3"
        >
          <p className="text-xs text-muted-foreground">
            {failureStageLabel(failure.stage)} ·{" "}
            {failureReasonLabel(failure.reason)}
          </p>
          <h3 className="font-mono text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
            {messageOf(event)}
          </h3>
          {!failure.errorMessage ? (
            <p className="text-sm text-muted-foreground">
              This client did not send the original error. Upgrade the app’s
              Insights plugin and server to collect details for future failures.
            </p>
          ) : null}
          <Button
            className="w-fit"
            variant="outline"
            onClick={() => void copy()}
          >
            <Copy aria-hidden="true" data-icon="inline-start" /> Copy report
          </Button>
        </section>
        <section
          aria-label="Stack trace"
          className="flex min-w-0 flex-col gap-2"
        >
          <h3 className="text-sm font-medium">Stack trace</h3>
          {failure.errorStack ? (
            <pre className="rounded-md border bg-muted/30 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">
              {failure.errorStack}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              No stack trace was sent with this report.
            </p>
          )}
        </section>
        <section aria-label="Report context" className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Report context</h3>
          <div className="text-xs text-muted-foreground">
            <EventTimestamp value={event.receivedAtMs} formatter={formatter} />
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            {context.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-sm wrap-anywhere">{value}</dd>
              </div>
            ))}
          </dl>
          <EventBundleTransition event={event} />
          <Button
            variant="outline"
            className="w-fit"
            render={
              <Link
                to="/installations"
                search={{ query: event.installId, installId: event.installId }}
              />
            }
          >
            Installation history{" "}
            <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
          </Button>
          <p className="font-mono text-xs text-muted-foreground wrap-anywhere">
            {event.installId}
          </p>
        </section>
        <section aria-label="Occurrences" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Occurrences in loaded reports</h3>
          <p className="text-xs text-muted-foreground">
            Select a report to inspect its stack and context. Times use your
            browser’s zone.
          </p>
          <div className="flex flex-col gap-1">
            {group.reports.map((report) => (
              <Button
                key={report.id}
                variant={report.id === event.id ? "secondary" : "ghost"}
                aria-pressed={report.id === event.id}
                className="h-auto min-h-11 justify-between gap-4 whitespace-normal"
                onClick={() => setSelectedId(report.id)}
              >
                <span className="text-left tabular-nums">
                  {formatter.format(report.receivedAtMs)}
                </span>
                <span className="shrink-0">{report.appVersion}</span>
              </Button>
            ))}
          </div>
        </section>
      </div>
    </SheetContent>
  );
}

export function FailureReportsList({
  pages,
  error,
  isPending,
  isFetching,
  hasNextPage,
  onLoadMore,
  onRefresh,
}: {
  readonly pages: readonly FailureReportsPage[];
  readonly error: Error | null;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly hasNextPage: boolean;
  readonly onLoadMore: () => void;
  readonly onRefresh: () => void;
}) {
  const groups = groupFailureReports(pages.flatMap((page) => page.data));
  const reportCount = groups.reduce(
    (sum, group) => sum + group.reports.length,
    0,
  );
  const scanned = pages.reduce((sum, page) => sum + page.scanned, 0);
  const formatter = useInsightsTimeFormat();
  return (
    <section
      aria-label="Errors to investigate"
      className="flex min-w-0 flex-col gap-3"
      aria-busy={isFetching}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Errors to investigate</h3>
          <p className="text-xs text-muted-foreground">
            Original messages, most reported first. Select an error for its
            stack and affected app.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Refresh error reports"
          disabled={isFetching}
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-40" aria-label="Loading error reports" />
      ) : (
        <>
          {error ? (
            <InsightsErrorAlert
              error={error}
              fallbackTitle="Error reports unavailable"
            />
          ) : null}
          {groups.length ? (
            <Table aria-label="Error messages">
              <TableHeader>
                <TableRow>
                  <TableHead>Error</TableHead>
                  <TableHead className="text-right">Reports</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">
                    Installations
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">
                    Last seen
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => {
                  const latest = group.reports[0]!;
                  const failure = latest.failure!;
                  return (
                    <TableRow key={group.key}>
                      <TableCell className="max-w-md whitespace-normal">
                        <Sheet>
                          <SheetTrigger
                            render={
                              <Button
                                variant="link"
                                className="h-auto min-h-11 w-full justify-start whitespace-normal px-0 text-left"
                              />
                            }
                          >
                            <span className="flex min-w-0 flex-col gap-1">
                              <span className="line-clamp-2 font-mono text-xs leading-relaxed wrap-anywhere">
                                {messageOf(latest)}
                              </span>
                              <span className="text-xs font-normal text-muted-foreground">
                                {[
                                  failureStageLabel(failure.stage),
                                  ...failureDetailParts(failure),
                                ].join(" · ")}
                              </span>
                            </span>
                          </SheetTrigger>
                          <FailureDetail group={group} />
                        </Sheet>
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {group.reports.length.toLocaleString()}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums sm:table-cell">
                        {group.installations.toLocaleString()}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground tabular-nums lg:table-cell">
                        {formatter.format(latest.receivedAtMs)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : !error ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {hasNextPage
                    ? "No failures in the events loaded so far"
                    : "No error reports in this range"}
                </EmptyTitle>
                <EmptyDescription>
                  {hasNextPage
                    ? "Load older events to continue investigating this period."
                    : "Reports appear here when a client sends an update failure. Raw history may be shorter than aggregate history."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground" role="status">
              {reportCount.toLocaleString()} failure reports from{" "}
              {scanned.toLocaleString()} events reviewed.
              {hasNextPage
                ? " More events remain; these counts are not period totals."
                : error
                  ? " Scan interrupted."
                  : " End of available range."}
              {pages[0]
                ? ` Raw history since ${formatter.format(pages[0].sinceMs)}.`
                : ""}
            </p>
            {hasNextPage ? (
              <Button
                variant="outline"
                disabled={isFetching}
                onClick={onLoadMore}
              >
                {isFetching ? "Loading…" : "Load older events"}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

export function FailureReports({
  input,
}: {
  readonly input: FailureReportsInput;
}) {
  const query = useFailureReportsQuery(input, true);
  return (
    <FailureReportsList
      pages={query.data?.pages ?? []}
      error={query.error}
      isPending={query.isPending}
      isFetching={query.isFetching}
      hasNextPage={query.hasNextPage}
      onLoadMore={() => void query.fetchNextPage()}
      onRefresh={() => void query.refetch()}
    />
  );
}
