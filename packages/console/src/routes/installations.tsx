import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useAnalyticsCapability } from "@/components/features/analytics/AnalyticsCapabilityContext";
import { InstallationHistoryCard } from "@/components/features/analytics/InstallationHistoryCard";
import { InstallationMatchesCard } from "@/components/features/analytics/InstallationMatchesCard";
import {
  InstallationPageHeader,
  InstallationResultsSkeleton,
  InstallationSearchPanel,
} from "@/components/features/analytics/InstallationPageHeader";
import {
  ensureAnalyticsRouteAccess,
  isAnalyticsQueryEnabled,
} from "@/lib/analytics-api";
import {
  type InstallationSearchRow,
  useInstallationHistoryQuery,
  useInstallationSearchQuery,
} from "@/lib/api";

import { validateInstallationsSearch } from "./-installations-search";

const SEARCH_LIMIT = 20;
const HISTORY_LIMIT = 50;

export const Route = createFileRoute("/installations")({
  beforeLoad: ({ context }) => ensureAnalyticsRouteAccess(context.queryClient),
  component: InstallationsPage,
  validateSearch: validateInstallationsSearch,
});

function InstallationsPage() {
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
    if (selectedInstallId || !firstMatchingInstallId) return;
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
      <InstallationPageHeader />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          <InstallationSearchPanel
            draftQuery={draftQuery}
            hasQuery={hasQuery}
            onClear={() => {
              setDraftQuery("");
              updateSearch({ query: undefined, installId: undefined });
            }}
            onDraftQueryChange={setDraftQuery}
            onSubmit={() => {
              const nextQuery = draftQuery.trim();
              updateSearch({
                query: nextQuery || undefined,
                installId: undefined,
              });
            }}
          />
          {!hasQuery ? null : isSearchLoading ? (
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
