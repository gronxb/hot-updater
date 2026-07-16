import { createFileRoute } from "@tanstack/react-router";
import { ChartNoAxesCombined } from "lucide-react";

import { useAnalyticsCapability } from "@/components/features/analytics/AnalyticsCapabilityContext";
import { AnalyticsOverview } from "@/components/features/analytics/AnalyticsOverview";
import { InstallationSearch } from "@/components/features/analytics/InstallationSearch";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAnalyticsOverviewQuery } from "@/lib/analytics-api";

export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const capability = useAnalyticsCapability();
  const overview = useAnalyticsOverviewQuery(capability);

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-3 sm:min-h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1" />
        <div className="flex items-center gap-1.5">
          <ChartNoAxesCombined
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
          <h1 className="text-sm font-medium">Analytics</h1>
        </div>
        <p className="basis-full pl-9 text-xs text-muted-foreground sm:basis-auto sm:pl-0">
          Based on the latest reported bundle event per installation.
        </p>
      </header>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
          {overview.isLoading ? (
            <AnalyticsOverview status="loading" />
          ) : overview.error ? (
            <AnalyticsOverview status="error" error={overview.error} />
          ) : overview.data ? (
            <AnalyticsOverview status="success" data={overview.data} />
          ) : (
            <AnalyticsOverview status="loading" />
          )}
          <InstallationSearch capability={capability} />
        </div>
      </main>
    </div>
  );
}
