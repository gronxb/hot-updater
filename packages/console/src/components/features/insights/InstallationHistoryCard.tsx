import { RefreshCw } from "lucide-react";

import { HashValueDisplay } from "@/components/HashValueDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type {
  InstallationHistoryResult,
  InstallationHistoryRow,
  InstallationSearchRow,
} from "@/lib/api";

import {
  EventBundleTransition,
  EventTimestamp,
  EventTypeBadge,
  useInsightsTimeFormat,
} from "./EventDetails";
import { EventHistoryList } from "./EventHistoryList";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InstallationPagination } from "./InstallationPagination";

const getUserLabel = (event: {
  readonly username: string | null;
  readonly userId: string | null;
}) => event.userId ?? event.username ?? "—";

const getLastKnownBundleId = (
  event: InstallationHistoryRow | InstallationSearchRow,
) =>
  "lastKnownBundleId" in event
    ? event.lastKnownBundleId
    : (event.toBundleId ?? event.fromBundleId);

export function InstallationHistoryCard({
  error,
  history,
  isLoading,
  limit,
  offset,
  onOffsetChange,
  onRefresh,
  selectedEvent,
  selectedInstallId,
}: {
  readonly error: unknown;
  readonly history: InstallationHistoryResult | undefined;
  readonly isLoading: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly onRefresh?: () => void;
  readonly onOffsetChange: (offset: number) => void;
  readonly selectedEvent:
    | InstallationHistoryRow
    | InstallationSearchRow
    | undefined;
  readonly selectedInstallId: string;
}) {
  const dateTimeFormat = useInsightsTimeFormat();
  const lastKnownBundleId = selectedEvent
    ? getLastKnownBundleId(selectedEvent)
    : undefined;

  return (
    <Card className="@container min-h-0 min-w-0 shadow-sm">
      <CardHeader className="p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle className="text-sm font-medium">
              <h2 className="flex flex-wrap items-center gap-2">
                {selectedInstallId
                  ? "Installation history"
                  : "Select an installation"}
                {history && !error ? (
                  <Badge variant="secondary" className="tabular-nums">
                    {history.pagination.total.toLocaleString()}
                  </Badge>
                ) : null}
              </h2>
            </CardTitle>
          </div>
          {onRefresh && selectedInstallId ? (
            <Button
              className="h-11 lg:h-8"
              size="lg"
              variant="outline"
              onClick={onRefresh}
              disabled={isLoading}
            >
              <RefreshCw aria-hidden="true" data-icon="inline-start" />
              Refresh
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="min-h-0 p-0">
        {selectedInstallId && selectedEvent ? (
          <>
            <section
              aria-labelledby="latest-installation-state"
              className="px-4 pb-4 sm:px-6 sm:pb-6"
            >
              <h3 className="sr-only" id="latest-installation-state">
                Latest reported state
              </h3>
              <dl className="grid grid-cols-2 gap-4 @[36rem]:grid-cols-3">
                <div className="col-span-2 min-w-0 @[36rem]:col-span-1">
                  <dt className="text-xs text-muted-foreground">User ID</dt>
                  <dd className="mt-1 text-sm font-medium wrap-anywhere">
                    {getUserLabel(selectedEvent)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Install ID</dt>
                  <dd className="mt-1 font-mono text-xs">
                    <HashValueDisplay
                      value={selectedInstallId}
                      buttonClassName="min-h-11 px-3 lg:min-h-0 lg:px-1.5"
                    />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">
                    Last known bundle
                  </dt>
                  <dd className="mt-1 font-mono text-xs">
                    {lastKnownBundleId ? (
                      <HashValueDisplay
                        value={lastKnownBundleId}
                        buttonClassName="min-h-11 px-3 lg:min-h-0 lg:px-1.5"
                      />
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              </dl>
            </section>
            <Separator />
          </>
        ) : null}
        {selectedInstallId ? (
          isLoading ? (
            <div
              className="flex flex-col gap-3 p-6"
              role="status"
              aria-label="Loading installation history"
            >
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error ? (
            <div className="p-6">
              <InsightsErrorAlert
                error={error instanceof Error ? error : new Error()}
                fallbackTitle="Installation history unavailable"
              />
            </div>
          ) : history && history.data.length > 0 ? (
            <>
              <div className="@[48rem]:hidden">
                <EventHistoryList
                  events={history.data}
                  formatter={dateTimeFormat}
                />
              </div>
              <div className="hidden @[48rem]:block">
                <Table className="min-w-3xl table-fixed">
                  <TableHeader>
                    <TableRow className="[&>th]:px-4 sm:[&>th]:px-6">
                      <TableHead className="w-64">Time</TableHead>
                      <TableHead className="w-48">Event</TableHead>
                      <TableHead className="w-32">App</TableHead>
                      <TableHead className="w-52">Bundle</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.data.map((event) => (
                      <TableRow
                        className="[&>td]:px-4 [&>td]:py-4 [&>td]:align-top sm:[&>td]:px-6"
                        key={event.id}
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
              <InstallationPagination
                label="Installation history"
                limit={limit}
                offset={offset}
                pageLength={history.data.length}
                total={history.pagination.total}
                onOffsetChange={onOffsetChange}
              />
            </>
          ) : (
            <div className="p-6 text-sm text-muted-foreground">
              No bundle changes recorded yet.
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
