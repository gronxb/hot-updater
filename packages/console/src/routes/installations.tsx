import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { useAnalyticsCapability } from "@/components/features/analytics/AnalyticsCapabilityContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isAnalyticsQueryEnabled } from "@/lib/analytics-api";
import {
  type InstallationHistoryRow,
  type InstallationSearchRow,
  useInstallationHistoryQuery,
  useInstallationSearchQuery,
} from "@/lib/api";

import { validateInstallationsSearch } from "./installations-search";

const SEARCH_LIMIT = 20;
const HISTORY_LIMIT = 50;

export const Route = createFileRoute("/installations")({
  component: InstallationsPage,
  validateSearch: validateInstallationsSearch,
});

function formatDateTime(value: string | number | Date | null | undefined) {
  if (!value) {
    return "—";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function getLastKnownBundleId(
  event: InstallationHistoryRow | InstallationSearchRow,
) {
  return "lastKnownBundleId" in event
    ? event.lastKnownBundleId
    : (event.toBundleId ?? event.fromBundleId);
}

function getEventStatus(event: InstallationHistoryRow | InstallationSearchRow) {
  return "latestStatus" in event ? event.latestStatus : event.type;
}

function getUserLabel(event: {
  username: string | null;
  userId: string | null;
}) {
  return event.username ?? event.userId ?? "—";
}

function SearchHeader({
  draftQuery,
  onDraftQueryChange,
  onSubmit,
  onClear,
  hasQuery,
}: {
  draftQuery: string;
  onDraftQueryChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  hasQuery: boolean;
}) {
  return (
    <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-3 sm:h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:py-0 sm:backdrop-blur-sm">
      <SidebarTrigger className="-ml-1" />

      <div className="ml-1 flex items-center gap-1.5 text-muted-foreground sm:ml-2">
        <Search className="h-3.5 w-3.5" />
        <span className="text-xs font-medium">Installations</span>
      </div>

      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Input
          value={draftQuery}
          onChange={(event) => onDraftQueryChange(event.target.value)}
          placeholder="Search username, user ID, or install ID"
          aria-label="Search installations"
          className="h-8 min-w-0 text-xs"
        />
        <Button type="submit" size="sm">
          Search
        </Button>
        {hasQuery ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        ) : null}
      </form>
    </header>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function InstallationsPage() {
  const capability = useAnalyticsCapability();
  const analyticsQueriesEnabled = isAnalyticsQueryEnabled(capability);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [draftQuery, setDraftQuery] = useState(search.query ?? "");

  useEffect(() => {
    setDraftQuery(search.query ?? "");
  }, [search.query]);

  const query = search.query?.trim() ?? "";
  const {
    data: results,
    error: searchError,
    isLoading: isSearchLoading,
  } = useInstallationSearchQuery(
    {
      query,
      limit: SEARCH_LIMIT,
      offset: search.searchOffset,
    },
    analyticsQueriesEnabled,
  );

  const selectedInstallId = search.installId ?? "";
  const firstMatchingInstallId = results?.data[0]?.installId;

  useEffect(() => {
    if (selectedInstallId || !firstMatchingInstallId) {
      return;
    }

    void navigate({
      to: "/installations",
      search: {
        query: search.query,
        installId: firstMatchingInstallId,
        searchOffset: search.searchOffset,
        historyOffset: 0,
      },
      replace: true,
    });
  }, [
    firstMatchingInstallId,
    navigate,
    search.query,
    search.searchOffset,
    selectedInstallId,
  ]);

  const {
    data: history,
    error: historyError,
    isLoading: isHistoryLoading,
  } = useInstallationHistoryQuery(
    {
      installId: selectedInstallId,
      limit: HISTORY_LIMIT,
      offset: search.historyOffset,
    },
    analyticsQueriesEnabled,
  );

  const selectedInstallation = useMemo(
    () =>
      results?.data.find(
        (event: InstallationSearchRow) => event.installId === selectedInstallId,
      ) ?? null,
    [results?.data, selectedInstallId],
  );
  const selectedEvent = selectedInstallation ?? history?.data[0];
  const selectedLastKnownBundleId = selectedEvent
    ? getLastKnownBundleId(selectedEvent)
    : undefined;

  const updateSearch = (
    nextSearch: {
      query?: string;
      installId?: string;
      searchOffset?: number;
      historyOffset?: number;
    },
    replace = false,
  ) => {
    void navigate({
      to: "/installations",
      search: {
        query: nextSearch.query,
        installId: nextSearch.installId,
        searchOffset: nextSearch.searchOffset ?? 0,
        historyOffset: nextSearch.historyOffset ?? 0,
      },
      replace,
    });
  };

  const hasQuery = query.length > 0 || selectedInstallId.length > 0;

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <SearchHeader
        draftQuery={draftQuery}
        onDraftQueryChange={setDraftQuery}
        onSubmit={() => {
          const nextQuery = draftQuery.trim();
          updateSearch({
            query: nextQuery || undefined,
            installId: undefined,
          });
        }}
        onClear={() => {
          setDraftQuery("");
          updateSearch({ query: undefined, installId: undefined });
        }}
        hasQuery={hasQuery}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 bg-muted/5 p-3 sm:p-6">
        {!hasQuery ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Search installations
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Search by username, user ID, or installation ID to inspect the
              latest known installation state and recorded update history.
            </CardContent>
          </Card>
        ) : isSearchLoading ? (
          <ResultsSkeleton />
        ) : (
          <div className="grid min-h-0 min-w-0 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <Card className="min-h-0 min-w-0">
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Matching installations ({results?.pagination.total ?? 0})
                </CardTitle>
              </CardHeader>
              <CardContent className="min-h-0 p-0">
                {results && results.data.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Installation</TableHead>
                        <TableHead>User</TableHead>
                        <TableHead>Last known bundle</TableHead>
                        <TableHead>Last event</TableHead>
                        <TableHead>Updated (UTC)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.data.map((event: InstallationSearchRow) => {
                        const currentBundleId = getLastKnownBundleId(event);

                        const isSelected =
                          event.installId === selectedInstallId;

                        return (
                          <TableRow
                            key={event.installId}
                            data-state={isSelected ? "selected" : undefined}
                          >
                            <TableCell className="align-top">
                              <Button
                                className="h-auto max-w-full justify-start p-0 font-normal focus-visible:ring-2"
                                onClick={() =>
                                  updateSearch({
                                    query: search.query,
                                    installId: event.installId,
                                    searchOffset: search.searchOffset,
                                  })
                                }
                                type="button"
                                variant="link"
                              >
                                <BundleIdDisplay bundleId={event.installId} />
                              </Button>
                            </TableCell>
                            <TableCell className="align-top text-sm">
                              {getUserLabel(event)}
                            </TableCell>
                            <TableCell className="align-top">
                              {currentBundleId ? (
                                <BundleIdDisplay bundleId={currentBundleId} />
                              ) : (
                                <span className="text-sm text-muted-foreground">
                                  —
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="align-top text-sm">
                              {getEventStatus(event)}
                            </TableCell>
                            <TableCell className="align-top text-sm text-muted-foreground">
                              {formatDateTime(event.receivedAtMs)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : searchError ? (
                  <div className="p-6 text-sm text-destructive">
                    {searchError instanceof Error
                      ? searchError.message
                      : "Failed to load installations."}
                  </div>
                ) : (
                  <div className="p-6 text-sm text-muted-foreground">
                    No installations matched that query.
                  </div>
                )}
                {results && results.pagination.total > 0 ? (
                  <PaginationControls
                    label="Installation results"
                    limit={SEARCH_LIMIT}
                    offset={search.searchOffset}
                    pageLength={results.data.length}
                    total={results.pagination.total}
                    onOffsetChange={(searchOffset) =>
                      updateSearch({
                        query: search.query,
                        installId: undefined,
                        searchOffset,
                        historyOffset: 0,
                      })
                    }
                  />
                ) : null}
              </CardContent>
            </Card>

            <Card className="min-h-0 min-w-0">
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  {selectedInstallId
                    ? "Installation history"
                    : "Select an installation"}
                </CardTitle>
              </CardHeader>
              <CardContent className="min-h-0 p-0">
                {selectedInstallId ? (
                  isHistoryLoading ? (
                    <div className="space-y-3 p-6">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : history && history.data.length > 0 ? (
                    <>
                      <div className="border-b px-6 py-4 text-sm">
                        <div className="font-medium text-foreground">
                          Latest reported state
                        </div>
                        <div className="mt-2 space-y-1 text-muted-foreground">
                          <div>
                            Installation:{" "}
                            <BundleIdDisplay bundleId={selectedInstallId} />
                          </div>
                          <div>
                            User:{" "}
                            {selectedEvent ? getUserLabel(selectedEvent) : "—"}
                          </div>
                          <div>
                            Last known bundle:{" "}
                            {selectedLastKnownBundleId ? (
                              <BundleIdDisplay
                                bundleId={selectedLastKnownBundleId}
                              />
                            ) : (
                              "—"
                            )}
                          </div>
                        </div>
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead>When (UTC)</TableHead>
                            <TableHead>Event</TableHead>
                            <TableHead>From</TableHead>
                            <TableHead>To</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {history.data.map((event: InstallationHistoryRow) => (
                            <TableRow key={event.id}>
                              <TableCell className="align-top text-sm text-muted-foreground">
                                {formatDateTime(event.receivedAtMs)}
                              </TableCell>
                              <TableCell className="align-top text-sm">
                                {event.type}
                              </TableCell>
                              <TableCell className="align-top">
                                <BundleIdDisplay
                                  bundleId={event.fromBundleId}
                                />
                              </TableCell>
                              <TableCell className="align-top">
                                <BundleIdDisplay bundleId={event.toBundleId} />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <PaginationControls
                        label="Installation history"
                        limit={HISTORY_LIMIT}
                        offset={search.historyOffset}
                        pageLength={history.data.length}
                        total={history.pagination.total}
                        onOffsetChange={(historyOffset) =>
                          updateSearch({
                            query: search.query,
                            installId: selectedInstallId,
                            searchOffset: search.searchOffset,
                            historyOffset,
                          })
                        }
                      />
                    </>
                  ) : historyError ? (
                    <div className="p-6 text-sm text-destructive">
                      {historyError instanceof Error
                        ? historyError.message
                        : "Failed to load installation history."}
                    </div>
                  ) : (
                    <div className="p-6 text-sm text-muted-foreground">
                      No history is available for this installation.
                    </div>
                  )
                ) : (
                  <div className="p-6 text-sm text-muted-foreground">
                    Choose an installation to inspect its update history.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function PaginationControls({
  label,
  limit,
  offset,
  pageLength,
  total,
  onOffsetChange,
}: {
  label: string;
  limit: number;
  offset: number;
  pageLength: number;
  total: number;
  onOffsetChange: (offset: number) => void;
}) {
  return (
    <nav
      aria-label={`${label} pagination`}
      className="flex items-center justify-between gap-3 border-t px-4 py-3"
    >
      <span className="text-xs text-muted-foreground">
        {offset + 1}–{Math.min(offset + pageLength, total)} of {total}
      </span>
      <div className="flex gap-2">
        <Button
          disabled={offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          size="sm"
          type="button"
          variant="outline"
        >
          Previous
        </Button>
        <Button
          disabled={offset + pageLength >= total}
          onClick={() => onOffsetChange(offset + limit)}
          size="sm"
          type="button"
          variant="outline"
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
