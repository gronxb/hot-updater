import {
  createFileRoute,
  useElementScrollRestoration,
} from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { EventHistoryCard } from "@/components/features/insights/EventHistoryCard";
import { useInsightsCapability } from "@/components/features/insights/InsightsCapabilityContext";
import { InsightsPageHeader } from "@/components/features/insights/InsightsPageHeader";
import { InstallationHistoryCard } from "@/components/features/insights/InstallationHistoryCard";
import { InstallationMatchesCard } from "@/components/features/insights/InstallationMatchesCard";
import {
  InstallationResultsSkeleton,
  InstallationSearchPanel,
} from "@/components/features/insights/InstallationPageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  type InstallationSearchRow,
  useEventHistoryQuery,
  useInstallationHistoryQuery,
  useInstallationSearchQuery,
} from "@/lib/api";
import {
  ensureInsightsRouteAccess,
  isInsightsQueryEnabled,
} from "@/lib/insights-api";

import {
  getInsightsScrollRestorationKey,
  validateInstallationsSearch,
} from "./-installations-search";

const SEARCH_LIMIT = 20;
const HISTORY_LIMIT = 50;

export const Route = createFileRoute("/installations")({
  beforeLoad: ({ context }) => ensureInsightsRouteAccess(context.queryClient),
  component: InstallationsPage,
  validateSearch: validateInstallationsSearch,
});

function InstallationsPage() {
  const capability = useInsightsCapability();
  const insightsQueriesEnabled = isInsightsQueryEnabled(capability);
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
    insightsQueriesEnabled,
  );
  const selectedInstallId = search.installId ?? "";
  const firstMatchingInstallId = results?.data[0]?.installId;

  useEffect(() => {
    if (!query || selectedInstallId || !firstMatchingInstallId) return;
    void navigate({
      to: "/installations",
      search: {
        query: search.query,
        installId: firstMatchingInstallId,
        searchOffset: search.searchOffset,
        historyOffset: 0,
        eventsOffset: search.eventsOffset,
      },
      replace: true,
    });
  }, [
    firstMatchingInstallId,
    navigate,
    query,
    search.eventsOffset,
    search.query,
    search.searchOffset,
    selectedInstallId,
  ]);

  const {
    data: history,
    error: historyError,
    isLoading: isHistoryLoading,
    refetch: refreshHistory,
  } = useInstallationHistoryQuery(
    {
      installId: selectedInstallId,
      limit: HISTORY_LIMIT,
      offset: search.historyOffset,
    },
    insightsQueriesEnabled,
  );
  const selectedInstallation = useMemo(
    () =>
      results?.data.find(
        (event: InstallationSearchRow) => event.installId === selectedInstallId,
      ) ?? null,
    [results?.data, selectedInstallId],
  );
  const selectedEvent = selectedInstallation ?? history?.data[0];

  const updateSearch = (
    nextSearch: {
      query?: string;
      installId?: string;
      searchOffset?: number;
      historyOffset?: number;
      eventsOffset?: number;
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
        eventsOffset:
          nextSearch.query || nextSearch.installId
            ? (nextSearch.eventsOffset ?? search.eventsOffset)
            : undefined,
      },
      replace,
    });
  };

  const hasQuery = query.length > 0 || selectedInstallId.length > 0;
  const eventsOffset = hasQuery
    ? (search.eventsOffset ?? 0)
    : search.historyOffset;
  const scrollRestorationId = `${hasQuery ? "installation-history" : "all-events"}-${search.historyOffset}`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollEntry = useElementScrollRestoration({
    id: scrollRestorationId,
    getKey: getInsightsScrollRestorationKey,
  });
  const events = useEventHistoryQuery(
    { limit: HISTORY_LIMIT, offset: search.historyOffset },
    insightsQueriesEnabled && !hasQuery,
  );
  useLayoutEffect(() => {
    if (!hasQuery && !events.isLoading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollEntry?.scrollY ?? 0;
    }
  }, [hasQuery, events.isLoading, scrollEntry?.scrollY, scrollRestorationId]);

  const clearLookup = () => {
    setDraftQuery("");
    updateSearch({ historyOffset: eventsOffset });
  };
  const installationLookup = (
    <InstallationSearchPanel
      draftQuery={draftQuery}
      onClear={clearLookup}
      onDraftQueryChange={setDraftQuery}
      onSubmit={() => {
        updateSearch({
          query: draftQuery.trim(),
          eventsOffset,
        });
      }}
    />
  );

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <InsightsPageHeader view="events" eventsOffset={eventsOffset} />
      <div
        key={scrollRestorationId}
        ref={scrollRef}
        data-scroll-restoration-id={scrollRestorationId}
        id="insights-events-scroll"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6"
      >
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          {hasQuery ? (
            <Card className="shadow-sm">
              <CardContent className="flex flex-col gap-4">
                <Button
                  className="-ml-2 self-start"
                  onClick={clearLookup}
                  variant="ghost"
                >
                  <ArrowLeft aria-hidden="true" data-icon="inline-start" />
                  Back to all events
                </Button>
                {installationLookup}
              </CardContent>
            </Card>
          ) : null}
          {!hasQuery ? (
            <EventHistoryCard
              error={events.error}
              history={events.data}
              isLoading={events.isLoading}
              limit={HISTORY_LIMIT}
              offset={search.historyOffset}
              onOffsetChange={(historyOffset) =>
                updateSearch({ historyOffset })
              }
              onRefresh={() => void events.refetch()}
              isFetching={events.isFetching}
            >
              {installationLookup}
            </EventHistoryCard>
          ) : isSearchLoading ? (
            <InstallationResultsSkeleton />
          ) : (
            <div className="grid min-h-0 min-w-0 items-stretch gap-6 lg:min-h-96 lg:grid-cols-[minmax(18rem,20rem)_minmax(0,1fr)]">
              <InstallationMatchesCard
                error={searchError}
                limit={SEARCH_LIMIT}
                offset={search.searchOffset}
                results={results}
                selectedInstallId={selectedInstallId}
                onOffsetChange={(searchOffset) =>
                  updateSearch({
                    query: search.query,
                    installId: undefined,
                    searchOffset,
                    historyOffset: 0,
                  })
                }
                onSelect={(installId) =>
                  updateSearch({
                    query: search.query,
                    installId,
                    searchOffset: search.searchOffset,
                  })
                }
              />
              <InstallationHistoryCard
                onRefresh={() => void refreshHistory()}
                error={historyError}
                history={history}
                isLoading={isHistoryLoading}
                limit={HISTORY_LIMIT}
                offset={search.historyOffset}
                selectedEvent={selectedEvent}
                selectedInstallId={selectedInstallId}
                onOffsetChange={(historyOffset) =>
                  updateSearch({
                    query: search.query,
                    installId: selectedInstallId,
                    searchOffset: search.searchOffset,
                    historyOffset,
                  })
                }
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
