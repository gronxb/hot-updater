import { Link } from "@tanstack/react-router";
import { ArrowUpRight, RefreshCw } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import type { EventHistoryResult } from "@/lib/api";

import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InstallationPagination } from "./InstallationPagination";

const eventLabels = {
  UPDATE_APPLIED: "Bundle applied",
  RECOVERED: "Recovered",
  RELEASE_ADOPTED: "Release adopted",
  UNCHANGED: "Unchanged",
} as const;

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

export function EventHistoryCard({
  error,
  history,
  isFetching,
  isLoading,
  limit,
  offset,
  onOffsetChange,
  onRefresh,
}: {
  readonly error: Error | null;
  readonly history: EventHistoryResult | undefined;
  readonly isFetching: boolean;
  readonly isLoading: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly onOffsetChange: (offset: number) => void;
  readonly onRefresh: () => void;
}) {
  return (
    <Card className="min-w-0" aria-busy={isFetching}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <CardTitle>
            <h2>All events</h2>
          </CardTitle>
          <CardDescription>
            All time, newest first. No filters applied.
          </CardDescription>
        </div>
        <Button disabled={isFetching} onClick={onRefresh} variant="outline">
          <RefreshCw aria-hidden="true" data-icon="inline-start" />
          Refresh events
        </Button>
      </CardHeader>
      <CardContent className="min-w-0 p-0">
        {isLoading ? (
          <div
            className="flex flex-col gap-4 p-6"
            role="status"
            aria-label="Loading events"
          >
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : error ? (
          <div className="px-6 pb-6">
            <InsightsErrorAlert
              error={error}
              fallbackTitle="Event history unavailable"
            />
          </div>
        ) : history && history.data.length > 0 ? (
          <>
            <Table className="min-w-4xl table-fixed">
              <TableHeader>
                <TableRow className="[&>th]:px-6">
                  <TableHead className="w-44">Reported (UTC)</TableHead>
                  <TableHead className="w-60">Installation / user</TableHead>
                  <TableHead className="w-36">App version</TableHead>
                  <TableHead className="w-40">Event</TableHead>
                  <TableHead>Bundle transition</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data.map((event) => (
                  <TableRow
                    key={event.id}
                    className="[&>td]:px-6 [&>td]:py-4 [&>td]:align-top"
                  >
                    <TableCell className="whitespace-normal text-xs text-muted-foreground tabular-nums">
                      {dateTimeFormat.format(event.receivedAtMs)}
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 flex-col items-start gap-2">
                        <Link
                          className={buttonVariants({
                            className: "-ml-2 max-w-full justify-start",
                            size: "sm",
                            variant: "ghost",
                          })}
                          to="/installations"
                          search={{
                            query: event.installId,
                            installId: event.installId,
                            searchOffset: 0,
                            historyOffset: 0,
                          }}
                          aria-label={`View history for installation ${event.installId}`}
                        >
                          <span className="truncate font-mono">
                            {event.installId}
                          </span>
                          <ArrowUpRight
                            aria-hidden="true"
                            data-icon="inline-end"
                          />
                        </Link>
                        <span className="max-w-full truncate text-xs text-muted-foreground">
                          {event.userId ?? event.username ?? "No user ID"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal text-xs">
                      <div className="flex flex-col gap-2">
                        <span className="font-mono">{event.appVersion}</span>
                        <span className="text-muted-foreground">
                          {event.platform === "ios" ? "iOS" : "Android"} ·{" "}
                          {event.channel}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {eventLabels[event.type]}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-normal text-xs">
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                        <dt className="text-muted-foreground">From</dt>
                        <dd>
                          {event.fromBundleId ? (
                            <BundleIdDisplay bundleId={event.fromBundleId} />
                          ) : (
                            "—"
                          )}
                        </dd>
                        <dt className="text-muted-foreground">To</dt>
                        <dd>
                          <BundleIdDisplay bundleId={event.toBundleId} />
                        </dd>
                      </dl>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <InstallationPagination
              label="All events"
              limit={limit}
              offset={offset}
              pageLength={history.data.length}
              total={history.pagination.total}
              onOffsetChange={onOffsetChange}
            />
          </>
        ) : (
          <div className="flex flex-col gap-2 px-6 pb-6 text-sm">
            <p>
              {offset > 0 ? "No events on this page" : "No events recorded yet"}
            </p>
            <p className="text-muted-foreground">
              {offset > 0
                ? "Return to the first page to see the latest events."
                : "Events appear when installations report update status. Refresh to check for new reports."}
            </p>
            {offset > 0 ? (
              <Button
                className="self-start"
                onClick={() => onOffsetChange(0)}
                variant="outline"
              >
                Go to first page
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
