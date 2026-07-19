import type { ActiveInstallationWindow } from "@hot-updater/plugin-core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChartNoAxesCombined } from "lucide-react";
import { useState } from "react";

import { useAnalyticsCapability } from "@/components/features/analytics/AnalyticsCapabilityContext";
import { AnalyticsControls } from "@/components/features/analytics/AnalyticsControls";
import { AnalyticsOverview } from "@/components/features/analytics/AnalyticsOverview";
import type { UpdateOutcomeState } from "@/components/features/analytics/UpdateOutcomes";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  ensureAnalyticsRouteAccess,
  useActiveInstallationQuery,
  useAnalyticsOverviewQuery,
} from "@/lib/analytics-api";
import { useBundleEventAnalyticsQuery } from "@/lib/api";

export const Route = createFileRoute("/analytics")({
  beforeLoad: ({ context }) => ensureAnalyticsRouteAccess(context.queryClient),
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const capability = useAnalyticsCapability();
  const navigate = useNavigate();
  const [window, setWindow] = useState<ActiveInstallationWindow>("30d");
  const [selectedBundleId, setSelectedBundleId] = useState("");
  const catalog = useAnalyticsOverviewQuery(capability);
  const active = useActiveInstallationQuery(capability, { window });
  const configuredById = new Map(
    catalog.data?.configuredRollouts.map((rollout) => [
      rollout.bundleId,
      rollout,
    ]) ?? [],
  );
  const bundleIds = new Set([
    ...(active.data?.bundles.map(({ bundleId }) => bundleId) ?? []),
    ...(catalog.data?.configuredRollouts.map(({ bundleId }) => bundleId) ?? []),
  ]);
  const bundleOptions = [...bundleIds].map((bundleId) => {
    const configured = configuredById.get(bundleId);
    const appVersion = configured?.bundle.targetAppVersion ?? "all versions";
    return {
      bundleId,
      description: configured
        ? `${configured.bundle.platform === "ios" ? "iOS" : "Android"} · ${configured.bundle.channel} · ${appVersion}`
        : "Metadata unavailable",
    };
  });
  const bundleId = bundleIds.has(selectedBundleId)
    ? selectedBundleId
    : (bundleOptions[0]?.bundleId ?? "");
  const outcomes = useBundleEventAnalyticsQuery(
    {
      bundleId,
      window,
      limit: 1,
      offset: 0,
    },
    capability.status === "supported" && bundleId.length > 0,
  );
  const outcomeState: UpdateOutcomeState = !bundleId
    ? { status: "idle" }
    : outcomes.isLoading
      ? { status: "loading", bundleId }
      : outcomes.error
        ? { status: "error", bundleId, error: outcomes.error }
        : outcomes.data
          ? {
              status: "success",
              bundleId,
              data: outcomes.data,
            }
          : { status: "loading", bundleId };
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
          Bundle adoption and movement over time.
        </p>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          {capability.status === "supported" &&
          capability.mode === "bounded" ? (
            <p className="text-xs text-muted-foreground">
              This database scans up to{" "}
              {capability.maxMatchingRows.toLocaleString()} matching analytics
              records per query.
            </p>
          ) : null}
          <AnalyticsControls
            onInstallationSearch={(query) => {
              void navigate({
                to: "/installations",
                search: {
                  query,
                  installId: undefined,
                  searchOffset: 0,
                  historyOffset: 0,
                },
              });
            }}
            onWindowChange={setWindow}
            window={window}
          />
          {active.isLoading || catalog.isLoading ? (
            <AnalyticsOverview status="loading" />
          ) : analyticsError ? (
            <AnalyticsOverview status="error" error={analyticsError} />
          ) : active.data && catalog.data ? (
            <AnalyticsOverview
              active={active.data}
              bundleId={bundleId}
              bundles={bundleOptions}
              catalog={catalog.data}
              onBundleChange={setSelectedBundleId}
              outcomes={outcomeState}
              status="success"
            />
          ) : (
            <AnalyticsOverview status="loading" />
          )}
        </div>
      </div>
    </div>
  );
}
