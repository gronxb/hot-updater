import type { ActiveInstallationWindow } from "@hot-updater/plugin-core";
import { createFileRoute } from "@tanstack/react-router";
import { ChartNoAxesCombined } from "lucide-react";
import { useState } from "react";

import { useAnalyticsCapability } from "@/components/features/analytics/AnalyticsCapabilityContext";
import { AnalyticsControls } from "@/components/features/analytics/AnalyticsControls";
import { AnalyticsOverview } from "@/components/features/analytics/AnalyticsOverview";
import { InstallationSearch } from "@/components/features/analytics/InstallationSearch";
import type { UpdateOutcomeState } from "@/components/features/analytics/UpdateOutcomes";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  useActiveInstallationQuery,
  useAnalyticsOverviewQuery,
} from "@/lib/analytics-api";
import { useBundleEventAnalyticsQuery } from "@/lib/api";

export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
});

export function AnalyticsPage() {
  const capability = useAnalyticsCapability();
  const [window, setWindow] = useState<ActiveInstallationWindow>("30d");
  const [userId, setUserId] = useState<string>();
  const catalog = useAnalyticsOverviewQuery(capability);
  const active = useActiveInstallationQuery(capability, { window, userId });
  const leadingBundleId = active.data?.bundles[0]?.bundleId ?? "";
  const outcomes = useBundleEventAnalyticsQuery(
    {
      bundleId: leadingBundleId,
      window: "30d",
      limit: 1,
      offset: 0,
    },
    capability.status === "supported" && leadingBundleId.length > 0,
  );
  const outcomeState: UpdateOutcomeState = !leadingBundleId
    ? { status: "idle" }
    : outcomes.isLoading
      ? { status: "loading", bundleId: leadingBundleId }
      : outcomes.error
        ? { status: "error", bundleId: leadingBundleId, error: outcomes.error }
        : outcomes.data
          ? {
              status: "success",
              bundleId: leadingBundleId,
              data: outcomes.data,
            }
          : { status: "loading", bundleId: leadingBundleId };
  const analyticsError = active.error ?? catalog.error;

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
          Received app-ready reports by installation.
        </p>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
          <AnalyticsControls
            onUserIdChange={setUserId}
            onWindowChange={setWindow}
            userId={userId}
            window={window}
          />
          {active.isLoading || catalog.isLoading ? (
            <AnalyticsOverview status="loading" />
          ) : analyticsError ? (
            <AnalyticsOverview status="error" error={analyticsError} />
          ) : active.data && catalog.data ? (
            <AnalyticsOverview
              active={active.data}
              catalog={catalog.data}
              outcomes={outcomeState}
              status="success"
              userId={userId}
            />
          ) : (
            <AnalyticsOverview status="loading" />
          )}
          <InstallationSearch capability={capability} />
        </div>
      </div>
    </div>
  );
}
