import type { InsightsBundleSelection } from "@hot-updater/server";
import { useState } from "react";

import { useInsightsEventsQuery } from "@/lib/insights-api";
import { outcomeLabels } from "@/lib/insights-view";

import { EventHistoryCard } from "./EventHistoryCard";

export type InsightsReportSelection = {
  readonly bundle: InsightsBundleSelection;
  readonly sinceMs: number;
  readonly beforeReceivedAtMs: number;
};

export function InsightsBundleReports({
  selection,
}: {
  readonly selection: InsightsReportSelection;
}) {
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([
    undefined,
  ]);
  const events = useInsightsEventsQuery(
    { ...selection, cursor: cursors.at(-1), limit: 50 },
    true,
  );
  return (
    <EventHistoryCard
      title={outcomeLabels[selection.bundle.outcome]}
      error={events.error}
      eventsLocation={{ eventsBefore: selection.beforeReceivedAtMs }}
      history={events.data}
      isFetching={events.isFetching}
      isLoading={events.isLoading}
      onNext={() => {
        const cursor = events.data?.nextCursor;
        if (cursor) setCursors((previous) => [...previous, cursor]);
      }}
      onPrevious={() => setCursors((previous) => previous.slice(0, -1))}
      onRefresh={() => {
        void events.refetch();
      }}
      pageNumber={cursors.length}
    >
      <p className="text-sm text-muted-foreground">
        Reports for the selected bundle and the measured period. New reports
        appear after refreshing the overview.
      </p>
    </EventHistoryCard>
  );
}
