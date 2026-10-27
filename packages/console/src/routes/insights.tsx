import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ConsoleFeatureUnavailable } from "@/components/ConsoleFeatureUnavailable";
import { AppUsage } from "@/components/features/insights/AppUsage";
import { FailureReports } from "@/components/features/insights/FailureReports";
import { InsightsControls } from "@/components/features/insights/InsightsControls";
import { InsightsOverview } from "@/components/features/insights/InsightsOverview";
import { InsightsPageHeader } from "@/components/features/insights/InsightsPageHeader";
import { InsightsScope } from "@/components/features/insights/InsightsScope";
import { UpdateFailures } from "@/components/features/insights/UpdateFailures";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { requireConsoleFeature } from "@/lib/console-features-api";
import {
  useInsightsRetention,
  useUpdateFailuresQuery,
} from "@/lib/insights-api";
import {
  comparedBundleIds,
  DEFAULT_INSIGHTS_CHANNEL,
  validateInsightsSearch,
} from "@/lib/insights-search";
import type { AppUsageScope, UsageWindow } from "@/lib/insights-usage";
import { getAppUsageReportRpc } from "@/lib/insights-usage-rpc";
import { useReleaseHealth } from "@/lib/release-adoption-api";

export const Route = createFileRoute("/insights")({
  beforeLoad: ({ context }) =>
    requireConsoleFeature(context.queryClient, "insightsAnalytics"),
  notFoundComponent: ConsoleFeatureUnavailable,
  component: InsightsPage,
  validateSearch: validateInsightsSearch,
});

function InsightsPage() {
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const retention = useInsightsRetention();
  const usageWindow = search.window ?? "24h";
  const bundleWindow = search.bundleWindow ?? "24h";
  const channel = search.channel ?? DEFAULT_INSIGHTS_CHANNEL;
  const platform = search.platform ?? "all";
  const scope: AppUsageScope = {
    platform,
    channel,
    appVersion: search.appVersion,
  };
  const setUsageWindow = (window: UsageWindow) =>
    void navigate({ search: { ...search, window } });
  const input = { ...scope, window: usageWindow };
  const bundleInput = {
    platform,
    channel,
    window: bundleWindow,
    ...(search.releaseId === undefined ? {} : { releaseId: search.releaseId }),
  } as const;
  const query = useQuery({
    queryKey: ["insights", "app-usage", input],
    queryFn: () => getAppUsageReportRpc({ data: input }),
    staleTime: 30_000,
  });
  const chart = search.healthChart ?? "adoption";
  const health = useReleaseHealth({
    platform,
    channel,
    window: bundleWindow,
    releaseIds: comparedBundleIds(search.bundles),
    focusReleaseId: search.releaseId,
    chart,
  });
  const failuresQuery = useUpdateFailuresQuery(bundleInput);
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <InsightsPageHeader view="overview" overviewSearch={search} />
      <InsightsControls
        filters={{
          channel,
          platform,
          appVersion: search.appVersion,
          releaseId: search.releaseId,
        }}
        appVersions={query.data?.appVersions ?? []}
        releases={health.candidates ?? []}
        onFiltersChange={(change) => {
          const next = { ...search, ...change };
          void navigate({
            search: {
              ...next,
              // Defaults stay out of the URL.
              channel:
                next.channel === DEFAULT_INSIGHTS_CHANNEL
                  ? undefined
                  : next.channel,
              platform: next.platform === "all" ? undefined : next.platform,
              // A release and bundles chosen in another channel or platform
              // do not carry over; a new focus picks its own bundles.
              ...("channel" in change || "platform" in change
                ? { releaseId: change.releaseId, bundles: undefined }
                : {}),
              ...("releaseId" in change ? { bundles: undefined } : {}),
            },
          });
        }}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 px-4 py-6 sm:p-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
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
            retention={retention}
          />
          <InsightsOverview
            input={bundleInput}
            chart={chart}
            onChartChange={(healthChart) =>
              void navigate({ search: { ...search, healthChart } })
            }
            health={health}
            onReleasesChange={(ids) =>
              void navigate({ search: { ...search, bundles: ids?.join(",") } })
            }
            onShowAllPlatforms={() =>
              void navigate({
                search: {
                  ...search,
                  platform: undefined,
                  releaseId: undefined,
                  bundles: undefined,
                },
              })
            }
            onWindowChange={(window) =>
              void navigate({
                search: {
                  ...search,
                  bundleWindow: window,
                },
              })
            }
          />
          <UpdateFailures
            scope={
              <InsightsScope
                channel={channel}
                platform={platform}
                narrower={
                  search.releaseId ? [`Release ${search.releaseId}`] : []
                }
              />
            }
            query={failuresQuery}
            errors={
              failuresQuery.data ? (
                <FailureReports
                  key={JSON.stringify(bundleInput)}
                  input={{
                    ...bundleInput,
                    beforeReceivedAtMs: failuresQuery.data.endMs,
                  }}
                />
              ) : null
            }
            onRefresh={() => {
              void failuresQuery.refetch();
              void queryClient.invalidateQueries({
                queryKey: ["insights", "failure-reports"],
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}
