import {
  createFileRoute,
  useElementScrollRestoration,
} from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { EventHistoryCard } from "@/components/features/insights/EventHistoryCard";
import { InsightsPageHeader } from "@/components/features/insights/InsightsPageHeader";
import {
  InsightsExpiredState,
  InsightsFailedState,
  InsightsPreparingState,
  InsightsStaleNotice,
} from "@/components/features/insights/InsightsReadState";
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
  useInsightsInstallationsQuery,
} from "@/lib/insights-api";
import { popInsightsCursor, pushInsightsCursor } from "@/lib/insights-cursor";
import {
  getExactInsightsTotal,
  toInsightsEventRow,
  toInsightsInstallationViewRow,
  type InsightsEventRow,
  type InsightsInstallationViewRow,
  type InsightsViewPage,
} from "@/lib/insights-view";

import {
  getInsightsScrollRestorationKey,
  validateInstallationsSearch,
} from "./-installations-search";

const SEARCH_LIMIT = 20;
const HISTORY_LIMIT = 50;
const freshBefore = () => Date.now() + 1;

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
      limit: HISTORY_LIMIT,
      selector: { kind: "all" },
    },
    !hasLookup,
  );
  const eventsRead = events.data;
  const eventsPage: InsightsViewPage<InsightsEventRow> | undefined =
    eventsRead?.state === "ready"
      ? {
          data: eventsRead.data.data.map(toInsightsEventRow),
          hasNext: eventsRead.data.hasNext,
          nextCursor: eventsRead.data.nextCursor,
          total: getExactInsightsTotal(
            eventsRead.data.total,
            eventsRead.versions.sourceGeneration,
          ),
        }
      : undefined;
  const eventsReadState =
    eventsRead?.state === "preparing" ? (
      <InsightsPreparingState label="Preparing event history" />
    ) : eventsRead?.state === "failed" ? (
      <InsightsFailedState failure={eventsRead.error} />
    ) : undefined;

  const matches = useInsightsInstallationsQuery(
    {
      kind: "contains",
      limit: SEARCH_LIMIT,
      query,
      ...(search.searchCursor === undefined
        ? {}
        : { cursor: search.searchCursor }),
      ...(search.searchPublicationId === undefined
        ? {}
        : { publicationId: search.searchPublicationId }),
    },
    hasSearchQuery,
  );
  const matchesRead = matches.data;
  const matchesData =
    matchesRead?.state === "ready" || matchesRead?.state === "stale"
      ? matchesRead.data
      : undefined;
  const matchesPage: InsightsViewPage<InsightsInstallationViewRow> | undefined =
    matchesData
      ? {
          data: matchesData.data.map(toInsightsInstallationViewRow),
          hasNext: matchesData.hasNext,
          nextCursor: matchesData.nextCursor,
          total: getExactInsightsTotal(
            matchesData.total,
            matchesRead?.state === "ready" || matchesRead?.state === "stale"
              ? matchesRead.versions.sourceGeneration
              : null,
          ),
        }
      : undefined;
  const matchesPublication =
    matchesData?.consistency.cutoff.kind === "publication"
      ? matchesData.consistency.cutoff.publication
      : undefined;

  useEffect(() => {
    const firstInstallId = matchesPage?.data[0]?.installId;
    if (!hasSearchQuery || hasSelection || firstInstallId === undefined) return;
    updateSearch(
      {
        installId: firstInstallId,
        historyBack: undefined,
        historyBefore: freshBefore(),
        historyCursor: undefined,
      },
      true,
    );
  }, [hasSearchQuery, hasSelection, matchesPage?.data]);

  const selectedInstallation = useInsightsInstallationsQuery(
    {
      kind: "installationId",
      installId: search.installId ?? "",
      limit: 1,
    },
    hasSelection,
  );
  const selectedRead = selectedInstallation.data;
  const selectedRow =
    selectedRead?.state === "ready" ? selectedRead.data.data[0] : undefined;
  const selectedInstallationState =
    selectedRead?.state === "preparing" ? (
      <InsightsPreparingState label="Preparing installation details" />
    ) : selectedRead?.state === "failed" ? (
      <InsightsFailedState failure={selectedRead.error} />
    ) : undefined;

  const history = useInsightsEventsQuery(
    {
      beforeReceivedAtMs: historyBefore,
      cursor: search.historyCursor,
      limit: HISTORY_LIMIT,
      selector: {
        kind: "installationId",
        installId: search.installId ?? "",
      },
    },
    hasSelection,
  );
  const historyRead = history.data;
  const historyPage: InsightsViewPage<InsightsEventRow> | undefined =
    historyRead?.state === "ready"
      ? {
          data: historyRead.data.data.map(toInsightsEventRow),
          hasNext: historyRead.data.hasNext,
          nextCursor: historyRead.data.nextCursor,
          total: getExactInsightsTotal(
            historyRead.data.total,
            historyRead.versions.sourceGeneration,
          ),
        }
      : undefined;
  const historyReadState =
    historyRead?.state === "preparing" ? (
      <InsightsPreparingState label="Preparing installation history" />
    ) : historyRead?.state === "failed" ? (
      <InsightsFailedState failure={historyRead.error} />
    ) : (
      selectedInstallationState
    );
  const selectedEvent = selectedRow
    ? toInsightsInstallationViewRow(selectedRow)
    : (matchesPage?.data.find(
        ({ installId }) => installId === search.installId,
      ) ?? historyPage?.data[0]);

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
    updateSearch({
      historyBack: undefined,
      historyBefore: undefined,
      historyCursor: undefined,
      installId: undefined,
      query: undefined,
      searchBack: undefined,
      searchCursor: undefined,
      searchPublicationId: undefined,
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
        updateSearch({
          historyBack: undefined,
          historyBefore: undefined,
          historyCursor: undefined,
          installId: undefined,
          query: nextQuery,
          searchBack: undefined,
          searchCursor: undefined,
          searchPublicationId: undefined,
        });
      }}
    />
  );

  const matchesState =
    matchesRead?.state === "preparing" ? (
      <InsightsPreparingState label="Preparing installation matches" />
    ) : matchesRead?.state === "failed" ? (
      <InsightsFailedState failure={matchesRead.error} />
    ) : matchesRead?.state === "expired" ? (
      <InsightsExpiredState
        onRestart={() =>
          updateSearch({
            searchBack: undefined,
            searchCursor: undefined,
            searchPublicationId: undefined,
          })
        }
      />
    ) : undefined;

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
                eventsBack: search.eventsBack,
                eventsBefore,
                eventsCursor: search.eventsCursor,
              }}
              history={eventsPage}
              isFetching={events.isFetching}
              isLoading={events.isLoading}
              onNext={() => {
                if (!eventsPage?.nextCursor) return;
                updateSearch({
                  eventsBack: pushInsightsCursor(
                    search.eventsBack,
                    search.eventsCursor,
                  ),
                  eventsCursor: eventsPage.nextCursor,
                });
              }}
              onPrevious={() => {
                const previous = popInsightsCursor(search.eventsBack);
                updateSearch({
                  eventsBack: previous.stack,
                  eventsCursor: previous.cursor,
                });
              }}
              onRefresh={() =>
                updateSearch({
                  eventsBack: undefined,
                  eventsBefore: freshBefore(),
                  eventsCursor: undefined,
                })
              }
              pageNumber={(search.eventsBack?.length ?? 0) + 1}
              readState={eventsReadState}
            >
              {installationLookup}
            </EventHistoryCard>
          ) : matches.isLoading && hasSearchQuery ? (
            <InstallationResultsSkeleton />
          ) : (
            <>
              {matchesRead?.state === "stale" && matchesPublication ? (
                <InsightsStaleNotice asOfMs={matchesPublication.asOfMs} />
              ) : null}
              <div
                className={`grid min-h-0 min-w-0 items-stretch gap-4 sm:gap-6 ${hasSearchQuery ? "lg:min-h-96 lg:grid-cols-[minmax(18rem,20rem)_minmax(0,1fr)]" : "lg:grid-cols-1"}`}
              >
                {hasSearchQuery ? (
                  matchesState ? (
                    <div>{matchesState}</div>
                  ) : (
                    <InstallationMatchesCard
                      error={matches.error}
                      onNext={() => {
                        if (!matchesPage?.nextCursor) return;
                        updateSearch({
                          installId: undefined,
                          searchBack: pushInsightsCursor(
                            search.searchBack,
                            search.searchCursor,
                          ),
                          searchCursor: matchesPage.nextCursor,
                          searchPublicationId: matchesPublication?.id,
                        });
                      }}
                      onPrevious={() => {
                        const previous = popInsightsCursor(search.searchBack);
                        updateSearch({
                          installId: undefined,
                          searchBack: previous.stack,
                          searchCursor: previous.cursor,
                        });
                      }}
                      onSelect={(installId) =>
                        updateSearch({
                          historyBack: undefined,
                          historyBefore: freshBefore(),
                          historyCursor: undefined,
                          installId,
                        })
                      }
                      pageNumber={(search.searchBack?.length ?? 0) + 1}
                      results={matchesPage}
                      selectedInstallId={search.installId}
                    />
                  )
                ) : null}
                <InstallationHistoryCard
                  onRefresh={() =>
                    updateSearch({
                      historyBack: undefined,
                      historyBefore: freshBefore(),
                      historyCursor: undefined,
                    })
                  }
                  error={history.error}
                  history={historyPage}
                  isLoading={
                    history.isLoading || selectedInstallation.isLoading
                  }
                  onNext={() => {
                    if (!historyPage?.nextCursor) return;
                    updateSearch({
                      historyBack: pushInsightsCursor(
                        search.historyBack,
                        search.historyCursor,
                      ),
                      historyCursor: historyPage.nextCursor,
                    });
                  }}
                  onPrevious={() => {
                    const previous = popInsightsCursor(search.historyBack);
                    updateSearch({
                      historyBack: previous.stack,
                      historyCursor: previous.cursor,
                    });
                  }}
                  pageNumber={(search.historyBack?.length ?? 0) + 1}
                  readState={historyReadState}
                  selectedEvent={selectedEvent}
                  selectedInstallId={search.installId}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
