import { Link } from "@tanstack/react-router";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { HashValueDisplay } from "@/components/HashValueDisplay";
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

import {
  EventBundleTransition,
  EventTimestamp,
  EventTypeBadge,
  useInsightsTimeFormat,
} from "./EventDetails";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InstallationPagination } from "./InstallationPagination";

export function EventHistoryCard({
  children,
  error,
  history,
  isFetching,
  isLoading,
  limit,
  offset,
  onOffsetChange,
  onRefresh,
}: {
  readonly children?: ReactNode;
  readonly error: Error | null;
  readonly history: EventHistoryResult | undefined;
  readonly isFetching: boolean;
  readonly isLoading: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly onOffsetChange: (offset: number) => void;
  readonly onRefresh: () => void;
}) {
  const dateTimeFormat = useInsightsTimeFormat();
  const timeZone = dateTimeFormat.resolvedOptions().timeZone;

  return (
    <Card className="min-w-0 shadow-sm" aria-busy={isFetching}>
      <CardHeader className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <CardTitle>
              <h2 className="flex items-center gap-2">
                All events
                {history && !error ? (
                  <Badge variant="secondary" className="tabular-nums">
                    {history.pagination.total.toLocaleString()}
                  </Badge>
                ) : null}
              </h2>
            </CardTitle>
            <CardDescription>
              All time, newest first. No filters applied.
            </CardDescription>
          </div>
          <Button
            disabled={isFetching}
            onClick={onRefresh}
            size="lg"
            variant="outline"
          >
            <RefreshCw aria-hidden="true" data-icon="inline-start" />
            Refresh
          </Button>
        </div>
        {children}
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
                <TableRow className="[&>th]:px-4 sm:[&>th]:px-6">
                  <TableHead className="w-52">Time ({timeZone})</TableHead>
                  <TableHead className="w-48">Event</TableHead>
                  <TableHead className="w-48">User ID / install ID</TableHead>
                  <TableHead className="w-32">App</TableHead>
                  <TableHead className="w-52">Bundle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data.map((event) => (
                  <TableRow
                    key={event.id}
                    className="[&>td]:px-4 [&>td]:py-4 [&>td]:align-top sm:[&>td]:px-6"
                  >
                    <TableCell className="whitespace-normal text-xs tabular-nums">
                      <EventTimestamp
                        value={event.receivedAtMs}
                        formatter={dateTimeFormat}
                      />
                    </TableCell>
                    <TableCell>
                      <EventTypeBadge type={event.type} />
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
                            eventsOffset: offset,
                          }}
                          aria-label={`View history for ${event.userId ?? event.username ?? "anonymous installation"} (${event.installId})`}
                        >
                          <span className="truncate">
                            {event.userId ??
                              event.username ??
                              "Anonymous installation"}
                          </span>
                          <ArrowUpRight
                            aria-hidden="true"
                            data-icon="inline-end"
                          />
                        </Link>
                        <HashValueDisplay
                          value={event.installId}
                          maxLength={13}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal text-xs">
                      <div className="flex flex-col gap-2">
                        <span>
                          {event.platform === "ios" ? "iOS" : "Android"}{" "}
                          {event.appVersion}
                        </span>
                        <span className="text-muted-foreground">
                          {event.channel}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal text-xs">
                      <EventBundleTransition event={event} />
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
