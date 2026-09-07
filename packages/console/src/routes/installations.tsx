import {
  createFileRoute,
  useElementScrollRestoration,
} from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { EventHistoryCard } from "@/components/features/insights/EventHistoryCard";
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
  useInsightsEventsQuery,
  useInsightsInstallationEventsQuery,
  useInsightsInstallationQuery,
  useInsightsInstallationsQuery,
} from "@/lib/insights-api";

import {
  getInsightsScrollRestorationKey,
  validateInstallationsSearch,
} from "./-installations-search";

const SEARCH_LIMIT = 20;
const EVENT_LIMIT = 50;
const freshBefore = () => Date.now();
const pushCursor = (stack: readonly string[], cursor: string | undefined) => [
  ...stack,
  cursor ?? "",
];
const popCursor = (stack: readonly string[]) => ({
  cursor: stack?.at(-1) || undefined,
  stack: stack.slice(0, -1),
});

export const Route = createFileRoute("/installations")({
  component: InstallationsPage,
  validateSearch: validateInstallationsSearch,
});

function InstallationsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [draftQuery, setDraftQuery] = useState(search.query ?? "");
  const [initialEventsBefore] = useState(freshBefore);
  const [initialHistoryBefore] = useState(freshBefore);
  const [eventsBack, setEventsBack] = useState<readonly string[]>([]);
  const [searchBack, setSearchBack] = useState<readonly string[]>([]);
  const [historyBack, setHistoryBack] = useState<readonly string[]>([]);
  const query = search.query?.trim() ?? "";
  const hasSearchQuery = query.length > 0;
  const hasSelection = search.installId !== undefined;
  const hasLookup = hasSearchQuery || hasSelection;
  const eventsBefore = search.eventsBefore ?? initialEventsBefore;
  const historyBefore = search.historyBefore ?? initialHistoryBefore;

  const updateSearch = (next: Partial<typeof search>, replace = false) => {
    void navigate({
      to: "/installations",
      search: { ...search, ...next },
      replace,
    });
  };

  useEffect(() => {
    setDraftQuery(search.query ?? "");
  }, [search.query]);

  useEffect(() => {
    if (search.eventsBefore === undefined) {
      updateSearch({ eventsBefore }, true);
    }
  }, [eventsBefore, search.eventsBefore]);

  useEffect(() => {
    if (hasSelection && search.historyBefore === undefined) {
      updateSearch({ historyBefore }, true);
    }
  }, [hasSelection, historyBefore, search.historyBefore]);

  const events = useInsightsEventsQuery(
    {
      beforeReceivedAtMs: eventsBefore,
      cursor: search.eventsCursor,
      limit: EVENT_LIMIT,
    },
    !hasLookup,
  );
  const matches = useInsightsInstallationsQuery(
    {
      cursor: search.searchCursor,
      identity: query,
      limit: SEARCH_LIMIT,
    },
    hasSearchQuery,
  );

  useEffect(() => {
    const firstInstallId = matches.data?.data[0]?.installId;
    if (!hasSearchQuery || hasSelection || firstInstallId === undefined) return;
    setHistoryBack([]);
    updateSearch(
      {
        historyBefore: freshBefore(),
        historyCursor: undefined,
        installId: firstInstallId,
      },
      true,
    );
  }, [hasSearchQuery, hasSelection, matches.data?.data]);

  const selectedInstallation = useInsightsInstallationQuery(
    search.installId ?? "",
    hasSelection,
  );
  const history = useInsightsInstallationEventsQuery(
    {
      beforeReceivedAtMs: historyBefore,
      cursor: search.historyCursor,
      installId: search.installId ?? "",
      limit: EVENT_LIMIT,
    },
    hasSelection,
  );
  const selectedEvent =
    selectedInstallation.data ??
    matches.data?.data.find(
      ({ installId }) => installId === search.installId,
    ) ??
    history.data?.data[0];

  const scrollRestorationId = hasLookup
    ? `installation-history-${search.historyCursor ?? "first"}`
    : `all-events-${search.eventsCursor ?? "first"}`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollEntry = useElementScrollRestoration({
    id: scrollRestorationId,
    getKey: getInsightsScrollRestorationKey,
  });
  useLayoutEffect(() => {
    if (!hasLookup && !events.isLoading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollEntry?.scrollY ?? 0;
    }
  }, [events.isLoading, hasLookup, scrollEntry?.scrollY, scrollRestorationId]);

  const clearLookup = () => {
    setDraftQuery("");
    setHistoryBack([]);
    setSearchBack([]);
    updateSearch({
      historyBefore: undefined,
      historyCursor: undefined,
      installId: undefined,
      query: undefined,
      searchCursor: undefined,
    });
  };
  const installationLookup = (
    <InstallationSearchPanel
      draftQuery={draftQuery}
      onClear={clearLookup}
      onDraftQueryChange={setDraftQuery}
      onSubmit={() => {
        const nextQuery = draftQuery.trim();
        if (!nextQuery) {
          clearLookup();
          return;
        }
        setHistoryBack([]);
        setSearchBack([]);
        updateSearch({
          historyBefore: undefined,
          historyCursor: undefined,
          installId: undefined,
          query: nextQuery,
          searchCursor: undefined,
        });
      }}
    />
  );

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <InsightsPageHeader view="events" />
      <div
        key={scrollRestorationId}
        ref={scrollRef}
        data-scroll-restoration-id={scrollRestorationId}
        id="insights-events-scroll"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6"
      >
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 sm:gap-6">
          {hasLookup ? (
            <Card className="shadow-sm">
              <CardContent className="flex flex-col gap-3 p-4 sm:p-6">
                <Button
                  className="-ml-2 h-11 self-start lg:h-8"
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
          {!hasLookup ? (
            <EventHistoryCard
              error={events.error}
              eventsLocation={{
                eventsBefore,
                eventsCursor: search.eventsCursor,
              }}
              history={events.data}
              isFetching={events.isFetching}
              isLoading={events.isLoading}
              onNext={() => {
                if (!events.data?.nextCursor) return;
                setEventsBack(pushCursor(eventsBack, search.eventsCursor));
                updateSearch(
                  {
                    eventsCursor: events.data.nextCursor,
                  },
                  true,
                );
              }}
              onPrevious={() => {
                const previous = popCursor(eventsBack);
                setEventsBack(previous.stack);
                updateSearch(
                  {
                    eventsCursor: previous.cursor,
                  },
                  true,
                );
              }}
              onRefresh={() => {
                setEventsBack([]);
                updateSearch(
                  {
                    eventsBefore: freshBefore(),
                    eventsCursor: undefined,
                  },
                  true,
                );
              }}
              pageNumber={eventsBack.length + 1}
            >
              {installationLookup}
            </EventHistoryCard>
          ) : matches.isLoading && hasSearchQuery ? (
            <InstallationResultsSkeleton />
          ) : (
            <div
              className={`grid min-h-0 min-w-0 items-stretch gap-4 sm:gap-6 ${hasSearchQuery ? "lg:min-h-96 lg:grid-cols-[minmax(18rem,20rem)_minmax(0,1fr)]" : "lg:grid-cols-1"}`}
            >
              {hasSearchQuery ? (
                <InstallationMatchesCard
                  error={matches.error}
                  onNext={() => {
                    if (!matches.data?.nextCursor) return;
                    setSearchBack(pushCursor(searchBack, search.searchCursor));
                    updateSearch(
                      {
                        installId: undefined,
                        searchCursor: matches.data.nextCursor,
                      },
                      true,
                    );
                  }}
                  onPrevious={() => {
                    const previous = popCursor(searchBack);
                    setSearchBack(previous.stack);
                    updateSearch(
                      {
                        installId: undefined,
                        searchCursor: previous.cursor,
                      },
                      true,
                    );
                  }}
                  onSelect={(installId) => {
                    setHistoryBack([]);
                    updateSearch({
                      historyBefore: freshBefore(),
                      historyCursor: undefined,
                      installId,
                    });
                  }}
                  pageNumber={searchBack.length + 1}
                  results={matches.data}
                  selectedInstallId={search.installId}
                />
              ) : null}
              <InstallationHistoryCard
                error={history.error ?? selectedInstallation.error}
                history={history.data}
                isLoading={history.isLoading || selectedInstallation.isLoading}
                onNext={() => {
                  if (!history.data?.nextCursor) return;
                  setHistoryBack(pushCursor(historyBack, search.historyCursor));
                  updateSearch(
                    {
                      historyCursor: history.data.nextCursor,
                    },
                    true,
                  );
                }}
                onPrevious={() => {
                  const previous = popCursor(historyBack);
                  setHistoryBack(previous.stack);
                  updateSearch(
                    {
                      historyCursor: previous.cursor,
                    },
                    true,
                  );
                }}
                onRefresh={() => {
                  setHistoryBack([]);
                  updateSearch(
                    {
                      historyBefore: freshBefore(),
                      historyCursor: undefined,
                    },
                    true,
                  );
                }}
                pageNumber={historyBack.length + 1}
                selectedEvent={selectedEvent}
                selectedInstallId={search.installId}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
