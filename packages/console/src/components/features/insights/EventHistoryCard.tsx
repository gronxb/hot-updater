import { Link } from "@tanstack/react-router";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { HashValueDisplay } from "@/components/HashValueDisplay";
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
import {
  EVENT_RANGES,
  type EventRange,
  eventRanges,
  type InsightsEventRow,
  type InsightsViewPage,
  widerEventRange,
} from "@/lib/insights-view";

import {
  EventBundleTransition,
  EventTimestamp,
  EventTypeDetails,
  useInsightsTimeFormat,
} from "./EventDetails";
import { EventHistoryList } from "./EventHistoryList";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InsightsPagination } from "./InsightsPagination";
import { PeriodSelector } from "./InsightsPeriodSelector";

type EventsLocationState = {
  readonly eventsBefore: number;
  readonly eventsCursor?: string;
  readonly eventsRange?: EventRange;
};

const rangePeriods = EVENT_RANGES.map((value) => ({
  value,
  name: `Last ${eventRanges[value].period}`,
}));

function EventIdentity({
  event,
  eventsLocation,
  touch = false,
}: {
  readonly event: InsightsEventRow;
  readonly eventsLocation: EventsLocationState;
  readonly touch?: boolean;
}) {
  return (
    <div
      className={
        touch
          ? "flex min-w-0 flex-wrap items-center justify-between gap-2"
          : "flex min-w-0 flex-col items-start gap-2"
      }
    >
      <Link
        className={buttonVariants({
          className: touch
            ? "-ml-2 h-auto min-h-11 min-w-0 flex-1 justify-start gap-2 whitespace-normal text-sm"
            : "-ml-2 max-w-full justify-start",
          size: "sm",
          variant: "ghost",
        })}
        to="/installations"
        search={{
          ...eventsLocation,
          query: event.installId || undefined,
          installId: event.installId,
        }}
        state={(previous) => ({
          insightsPagination: {
            eventsBack: previous.insightsPagination?.eventsBack,
          },
        })}
        aria-label={`View history for ${event.userId ?? event.username ?? "anonymous installation"} (${event.installId})`}
      >
        <span
          className={touch ? "min-w-0 text-left wrap-anywhere" : "truncate"}
        >
          {event.userId ?? event.username ?? "Anonymous installation"}
        </span>
        <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
      </Link>
      <HashValueDisplay
        value={event.installId}
        maxLength={13}
        buttonClassName={touch ? "min-h-11 px-3" : undefined}
      />
    </div>
  );
}

export function EventHistoryCard({
  children,
  description,
  error,
  eventsLocation,
  history,
  isFetching,
  isLoading,
  onNext,
  onPrevious,
  onRangeChange,
  onRefresh,
  pageNumber,
  range,
  title = "All events",
}: {
  readonly children?: ReactNode;
  /** One line under the title that says what the list holds. */
  readonly description?: ReactNode;
  readonly error: Error | null;
  readonly eventsLocation: EventsLocationState;
  readonly history: InsightsViewPage<InsightsEventRow> | undefined;
  readonly isFetching: boolean;
  readonly isLoading: boolean;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  /** Lets the list change its range; a list with a fixed window leaves it out. */
  readonly onRangeChange?: (range: EventRange) => void;
  readonly onRefresh: () => void;
  readonly pageNumber: number;
  /** The time range the list reads, named by its empty and end states. */
  readonly range?: EventRange;
  readonly title?: string;
}) {
  const dateTimeFormat = useInsightsTimeFormat();
  const hasPrevious = pageNumber > 1;
  const wider = range === undefined ? undefined : widerEventRange(range);
  const widen =
    wider !== undefined && onRangeChange ? (
      <Button
        className="h-11 px-3 lg:h-8"
        onClick={() => onRangeChange(wider)}
        type="button"
        variant="outline"
      >
        {`Show the last ${eventRanges[wider].period}`}
      </Button>
    ) : null;

  return (
    <Card className="@container min-w-0 shadow-sm" aria-busy={isFetching}>
      <CardHeader className="gap-4 p-4 sm:p-6">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>
              <h2>{title}</h2>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {range !== undefined && onRangeChange ? (
                <PeriodSelector
                  label="Time range"
                  onPeriodChange={onRangeChange}
                  period={range}
                  periods={rangePeriods}
                />
              ) : null}
              <Button
                className="h-11 lg:h-8"
                disabled={isFetching}
                onClick={onRefresh}
                size="lg"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" data-icon="inline-start" />
                Refresh
              </Button>
            </div>
          </div>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
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
        ) : history ? (
          <>
            {history.data.length > 0 ? (
              <>
                <div className="@[58rem]:hidden">
                  <EventHistoryList
                    events={history.data}
                    formatter={dateTimeFormat}
                    renderIdentity={(event) => (
                      <EventIdentity
                        event={event}
                        eventsLocation={eventsLocation}
                        touch
                      />
                    )}
                  />
                </div>
                <div className="hidden @[58rem]:block">
                  <Table className="min-w-4xl table-fixed">
                    <TableHeader>
                      <TableRow className="[&>th]:px-4 sm:[&>th]:px-6">
                        <TableHead className="w-64">Time</TableHead>
                        <TableHead className="w-48">Event</TableHead>
                        <TableHead className="w-48">
                          User / installation
                        </TableHead>
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
                            <EventTypeDetails type={event.type} />
                          </TableCell>
                          <TableCell>
                            <EventIdentity
                              event={event}
                              eventsLocation={eventsLocation}
                            />
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
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-4 sm:px-6 sm:pb-6">
                <p className="text-sm text-muted-foreground">
                  {hasPrevious
                    ? "No older events in this range."
                    : range !== undefined
                      ? `No events in the last ${eventRanges[range].period}.`
                      : title === "All events"
                        ? "No events recorded yet"
                        : "No matching reports in this period"}
                </p>
                {hasPrevious ? null : widen}
              </div>
            )}
            {range !== undefined &&
            history.nextCursor === null &&
            (history.data.length > 0 || hasPrevious) ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 sm:px-6">
                <p className="text-sm text-muted-foreground">
                  Start of range reached
                </p>
                {widen}
              </div>
            ) : null}
            {history.data.length > 0 || hasPrevious || history.nextCursor ? (
              <InsightsPagination
                hasPrevious={hasPrevious}
                label={title}
                nextCursor={history.nextCursor}
                onNext={onNext}
                onPrevious={onPrevious}
                pageLength={history.data.length}
                pageNumber={pageNumber}
              />
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
