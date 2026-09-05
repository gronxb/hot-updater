import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import {
  InsightsBundleReports,
  type InsightsReportSelection,
} from "@/components/features/insights/InsightsBundleReports";
import { InsightsControls } from "@/components/features/insights/InsightsControls";
import { InsightsOverview } from "@/components/features/insights/InsightsOverview";
import { InsightsPageHeader } from "@/components/features/insights/InsightsPageHeader";
import { Button } from "@/components/ui/button";
import {
  type InsightsWindow,
  type InsightsOverviewInput,
  useReportingInstallationsQuery,
} from "@/lib/insights-api";

export const Route = createFileRoute("/insights")({
  component: InsightsPage,
});

function InsightsPage() {
  const [window, setWindow] = useState<InsightsWindow>("30d");
  const [scope, setScope] = useState<Omit<InsightsOverviewInput, "window">>({
    platform: "ios",
    channel: "production",
  });
  const [selection, setSelection] = useState<InsightsReportSelection | null>(
    null,
  );
  const active = useReportingInstallationsQuery({ ...scope, window });

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <InsightsPageHeader view="overview" />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:gap-6">
          <InsightsControls
            scope={scope}
            onScopeChange={(next) => {
              setScope(next);
              setSelection(null);
            }}
            onWindowChange={(next) => {
              setWindow(next);
              setSelection(null);
            }}
            window={window}
          />
          <Button
            className="h-11 self-end lg:h-8"
            variant="outline"
            disabled={active.isFetching}
            onClick={() => {
              setSelection(null);
              void active.refetch();
            }}
          >
            Refresh overview
          </Button>
          {active.isLoading ? (
            <InsightsOverview status="loading" />
          ) : active.error ? (
            <InsightsOverview status="error" error={active.error} />
          ) : active.data ? (
            <InsightsOverview
              status="success"
              active={active.data}
              onOutcomeSelect={setSelection}
            />
          ) : (
            <InsightsOverview status="loading" />
          )}
          {selection ? (
            <InsightsBundleReports
              key={JSON.stringify(selection)}
              selection={selection}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
