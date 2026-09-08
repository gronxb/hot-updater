import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { InsightsControls } from "@/components/features/insights/InsightsControls";
import { InsightsOverview } from "@/components/features/insights/InsightsOverview";
import { InsightsPageHeader } from "@/components/features/insights/InsightsPageHeader";
import { ReportingDevicesSummary } from "@/components/features/insights/ReportingDevicesSummary";
import {
  type InsightsWindow,
  type InsightsOverviewInput,
} from "@/lib/insights-api";

export const Route = createFileRoute("/insights")({
  component: InsightsPage,
});

function InsightsPage() {
  const [window, setWindow] = useState<InsightsWindow>("24h");
  const [scope, setScope] = useState<Omit<InsightsOverviewInput, "window">>({
    platform: "ios",
    channel: "production",
  });

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <InsightsPageHeader view="overview" />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 px-4 py-6 sm:p-8">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 sm:gap-8">
          <InsightsControls
            scope={scope}
            onScopeChange={(next) => {
              setScope(next);
            }}
          />
          <ReportingDevicesSummary scope={scope} />
          <InsightsOverview
            input={{ ...scope, window }}
            onWindowChange={setWindow}
          />
        </div>
      </div>
    </div>
  );
}
