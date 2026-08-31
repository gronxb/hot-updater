import type { ActiveInstallationWindow } from "@hot-updater/server";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { useInsightsCapability } from "@/components/features/insights/InsightsCapabilityContext";
import { InsightsControls } from "@/components/features/insights/InsightsControls";
import { InsightsOverview } from "@/components/features/insights/InsightsOverview";
import { InsightsPageHeader } from "@/components/features/insights/InsightsPageHeader";
import type { UpdateOutcomeState } from "@/components/features/insights/UpdateOutcomes";
import { useBundleEventInsightsQuery } from "@/lib/api";
import {
  ensureInsightsRouteAccess,
  useActiveInstallationQuery,
  useInsightsOverviewQuery,
} from "@/lib/insights-api";

export const Route = createFileRoute("/insights")({
  beforeLoad: ({ context }) => ensureInsightsRouteAccess(context.queryClient),
  component: InsightsPage,
});

function InsightsPage() {
  const capability = useInsightsCapability();
  const [window, setWindow] = useState<ActiveInstallationWindow>("30d");
  const [selectedBundleId, setSelectedBundleId] = useState("");
  const catalog = useInsightsOverviewQuery(capability);
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
  const outcomes = useBundleEventInsightsQuery(
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
  const insightsError = active.error ?? catalog.error;

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <InsightsPageHeader view="overview" />

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <InsightsControls onWindowChange={setWindow} window={window} />
          {active.isLoading || catalog.isLoading ? (
            <InsightsOverview status="loading" />
          ) : insightsError ? (
            <InsightsOverview status="error" error={insightsError} />
          ) : active.data && catalog.data ? (
            <InsightsOverview
              active={active.data}
              bundleId={bundleId}
              bundles={bundleOptions}
              catalog={catalog.data}
              onBundleChange={setSelectedBundleId}
              outcomes={outcomeState}
              status="success"
            />
          ) : (
            <InsightsOverview status="loading" />
          )}
        </div>
      </div>
    </div>
  );
}
