import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AppUsage } from "@/components/features/insights/AppUsage";
import { InsightsControls } from "@/components/features/insights/InsightsControls";
import { InsightsOverview } from "@/components/features/insights/InsightsOverview";
import { InsightsPageHeader } from "@/components/features/insights/InsightsPageHeader";
import {
  InsightsActivityUnavailable,
  InsightsOffBanner,
} from "@/components/features/insights/InsightsUnavailable";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  type InsightsWindow,
  useInsightsStatusQuery,
} from "@/lib/insights-api";
import { getRecoveryReportRpc } from "@/lib/insights-recovery-rpc";
import { validateInsightsSearch } from "@/lib/insights-search";
import type { AppUsageScope } from "@/lib/insights-usage";
import { getAppUsageReportRpc } from "@/lib/insights-usage-rpc";

export const Route = createFileRoute("/insights")({
  component: InsightsPage,
  validateSearch: validateInsightsSearch,
});

function InsightsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const usageWindow = search.window ?? "24h";
  const bundleWindow = search.bundleWindow ?? "7d";
  const channel = search.channel ?? search.healthChannel ?? "production";
  const scope: AppUsageScope = {
    platform: search.platform ?? "all",
    channel,
    appVersion: search.appVersion,
  };
  const setUsageWindow = (window: InsightsWindow) =>
    void navigate({ search: { ...search, window } });
  const input = { ...scope, window: usageWindow };
  const bundleInput = {
    platform: search.healthPlatform ?? "ios",
    channel,
    window: bundleWindow,
    ...(search.releaseId === undefined ? {} : { releaseId: search.releaseId }),
  } as const;
  const status = useInsightsStatusQuery();
  const activity = status.data?.activity === true;
  const query = useQuery({
    queryKey: ["insights", "app-usage", input],
    queryFn: () => getAppUsageReportRpc({ data: input }),
    enabled: activity,
    staleTime: 30_000,
  });
  const bundleQuery = useQuery({
    queryKey: ["insights", "recovery", bundleInput],
    queryFn: () => getRecoveryReportRpc({ data: bundleInput }),
    enabled: activity,
    staleTime: 30_000,
  });
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <InsightsPageHeader view="overview" overviewSearch={search} />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 px-4 py-6 sm:p-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          {status.data?.insights === "off" ? <InsightsOffBanner /> : null}
          {status.data?.insights === "on" && !activity ? (
            <InsightsActivityUnavailable />
          ) : null}
          {activity || status.isPending ? (
            <>
              <InsightsControls
                key={JSON.stringify({ scope, bundleInput })}
                scope={scope}
                releaseScope={bundleInput}
                appVersions={query.data?.appVersions ?? []}
                onFiltersChange={({ scope, releaseScope }) =>
                  void navigate({
                    search: {
                      ...search,
                      ...scope,
                      appVersion: scope.appVersion,
                      healthPlatform: releaseScope.platform,
                      healthChannel: undefined,
                      releaseId: releaseScope.releaseId,
                    },
                  })
                }
              />
              {query.data?.truncated && !query.error ? (
                <Alert>
                  <AlertTitle>Partial history</AlertTitle>
                  <AlertDescription>
                    Only reports since{" "}
                    {new Date(query.data.sinceMs).toLocaleString("en", {
                      timeZone: "UTC",
                    })}{" "}
                    UTC are available. The active-user count is a lower bound.
                    Choose a shorter period for a more complete view.
                  </AlertDescription>
                </Alert>
              ) : null}
              <AppUsage
                query={query}
                search={{ ...scope, window: usageWindow, bundleWindow }}
                window={usageWindow}
                onWindowChange={setUsageWindow}
              />
              <InsightsOverview
                input={bundleInput}
                query={bundleQuery}
                onWindowChange={(window) =>
                  void navigate({
                    search: {
                      ...search,
                      bundleWindow: window,
                    },
                  })
                }
                onRefresh={() => void bundleQuery.refetch()}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
