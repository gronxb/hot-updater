import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { InsightsControls } from "@/components/features/insights/InsightsControls";
import { InsightsOverview } from "@/components/features/insights/InsightsOverview";
import { InsightsPageHeader } from "@/components/features/insights/InsightsPageHeader";
import {
  type InsightsWindow,
  useReportingInstallationsQuery,
} from "@/lib/insights-api";

export const Route = createFileRoute("/insights")({
  component: InsightsPage,
});

function InsightsPage() {
  const [window, setWindow] = useState<InsightsWindow>("30d");
  const active = useReportingInstallationsQuery(window);

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <InsightsPageHeader view="overview" />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:gap-6">
          <InsightsControls onWindowChange={setWindow} window={window} />
          {active.isLoading ? (
            <InsightsOverview status="loading" />
          ) : active.error ? (
            <InsightsOverview status="error" error={active.error} />
          ) : active.data ? (
            <InsightsOverview status="success" active={active.data} />
          ) : (
            <InsightsOverview status="loading" />
          )}
        </div>
      </div>
    </div>
  );
}
