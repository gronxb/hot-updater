import { normalizeRolloutCohortCount } from "@hot-updater/core";
import type { InsightsActiveWindow } from "@hot-updater/plugin-core";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { BundleSelector } from "@/components/features/insights/BundleSelector";
import { InsightsControls } from "@/components/features/insights/InsightsControls";
import { InsightsOverview } from "@/components/features/insights/InsightsOverview";
import { InsightsPageHeader } from "@/components/features/insights/InsightsPageHeader";
import {
  InsightsExpiredState,
  InsightsFailedState,
  InsightsPreparingState,
  InsightsStaleNotice,
} from "@/components/features/insights/InsightsReadState";
import type { UpdateOutcomeState } from "@/components/features/insights/UpdateOutcomes";
import { Button } from "@/components/ui/button";
import { useBundleQuery, useReleasesQuery } from "@/lib/api";
import {
  useInsightsReportPageQuery,
  useInsightsReportQuery,
} from "@/lib/insights-api";
import { popInsightsCursor, pushInsightsCursor } from "@/lib/insights-cursor";
import { getExactInsightsTotal } from "@/lib/insights-view";

import { validateInsightsSearch } from "./-insights-search";

const REPORT_PAGE_LIMIT = 100;

export const Route = createFileRoute("/insights")({
  component: InsightsPage,
  validateSearch: validateInsightsSearch,
});

function InsightsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [window, setWindow] = useState<InsightsActiveWindow>("30d");
  const [selectedBundleId, setSelectedBundleId] = useState("");
  const [activeMinAsOfMs, setActiveMinAsOfMs] = useState<number>();
  const [overviewMinAsOfMs, setOverviewMinAsOfMs] = useState<number>();
  const [detailMinAsOfMs, setDetailMinAsOfMs] = useState<number>();

  const updateSearch = (next: Partial<typeof search>) => {
    void navigate({
      to: "/insights",
      search: { ...search, ...next },
    });
  };

  const activeReport = useInsightsReportQuery({
    query: { kind: "activeOverview", window },
    ...(activeMinAsOfMs === undefined ? {} : { minAsOfMs: activeMinAsOfMs }),
  });
  const overviewReport = useInsightsReportQuery({
    query: { kind: "installationOverview" },
    ...(overviewMinAsOfMs === undefined
      ? {}
      : { minAsOfMs: overviewMinAsOfMs }),
  });
  const activeRead = activeReport.data;
  const overviewRead = overviewReport.data;
  const activePublication =
    (activeRead?.state === "ready" || activeRead?.state === "stale") &&
    activeRead.data.kind === "activeOverview"
      ? activeRead.data
      : undefined;
  const overviewPublication =
    (overviewRead?.state === "ready" || overviewRead?.state === "stale") &&
    overviewRead.data.kind === "installationOverview"
      ? overviewRead.data
      : undefined;

  const activeSeries = useInsightsReportPageQuery(
    {
      limit: REPORT_PAGE_LIMIT,
      publicationId: activePublication?.id ?? "",
      section: "activeSeries",
    },
    activePublication !== undefined,
  );
  const activeSeriesRead = activeSeries.data;
  const activeSeriesData =
    activeSeriesRead?.state === "ready" &&
    activeSeriesRead.data.section === "activeSeries"
      ? activeSeriesRead.data
      : undefined;

  const distributionPublicationId =
    search.bundlePublicationId ?? overviewPublication?.id ?? "";
  const bundleDistribution = useInsightsReportPageQuery(
    {
      cursor: search.bundleCursor,
      limit: REPORT_PAGE_LIMIT,
      publicationId: distributionPublicationId,
      section: "bundleDistribution",
    },
    distributionPublicationId.length > 0,
  );
  const distributionRead = bundleDistribution.data;
  const distributionData =
    distributionRead?.state === "ready" &&
    distributionRead.data.section === "bundleDistribution"
      ? distributionRead.data
      : undefined;
  const bundleRows = distributionData?.data ?? [];
  const bundleId = bundleRows.some(
    ({ bundleId }) => bundleId === selectedBundleId,
  )
    ? selectedBundleId
    : (bundleRows[0]?.bundleId ?? "");

  const selectedBundle = useBundleQuery(bundleId);
  const selectedReleases = useReleasesQuery(
    { bundleId, limit: 1 },
    bundleId.length > 0,
  );
  const selectedRelease = selectedReleases.data?.data[0];
  const configuredPercentage =
    selectedRelease?.bundle_id === bundleId
      ? normalizeRolloutCohortCount(selectedRelease.rollout_cohort_count) / 10
      : null;
  const bundleOptions = bundleRows.map((row) => ({
    bundleId: row.bundleId,
    description:
      row.bundleId === bundleId && selectedBundle.data
        ? `${selectedBundle.data.platform === "ios" ? "iOS" : "Android"} · ${selectedBundle.data.metadata?.app_version ?? "all versions"}`
        : `${row.installations.toLocaleString()} tracked installations`,
  }));

  const detailReport = useInsightsReportQuery(
    {
      query: { bundleId, kind: "bundleDetail", window },
      ...(detailMinAsOfMs === undefined ? {} : { minAsOfMs: detailMinAsOfMs }),
    },
    bundleId.length > 0,
  );
  const detailRead = detailReport.data;
  const detailPublication =
    (detailRead?.state === "ready" || detailRead?.state === "stale") &&
    detailRead.data.kind === "bundleDetail"
      ? detailRead.data
      : undefined;
  const installedSeries = useInsightsReportPageQuery(
    {
      limit: REPORT_PAGE_LIMIT,
      metric: "installed",
      publicationId: detailPublication?.id ?? "",
      section: "movementSeries",
    },
    detailPublication !== undefined,
  );
  const recoveredSeries = useInsightsReportPageQuery(
    {
      limit: REPORT_PAGE_LIMIT,
      metric: "recovered",
      publicationId: detailPublication?.id ?? "",
      section: "movementSeries",
    },
    detailPublication !== undefined,
  );
  const installedRead = installedSeries.data;
  const recoveredRead = recoveredSeries.data;
  const installedData =
    installedRead?.state === "ready" &&
    installedRead.data.section === "movementSeries" &&
    installedRead.data.metric === "installed"
      ? installedRead.data.data
      : undefined;
  const recoveredData =
    recoveredRead?.state === "ready" &&
    recoveredRead.data.section === "movementSeries" &&
    recoveredRead.data.metric === "recovered"
      ? recoveredRead.data.data
      : undefined;

  const restartDetail = () => setDetailMinAsOfMs(Date.now());
  const outcomes: UpdateOutcomeState = !bundleId
    ? { status: "idle" }
    : detailReport.error
      ? { status: "error", bundleId, error: detailReport.error }
      : detailRead?.state === "preparing"
        ? { status: "preparing", bundleId }
        : detailRead?.state === "failed"
          ? { status: "failed", bundleId, failure: detailRead.error }
          : installedRead?.state === "failed"
            ? { status: "failed", bundleId, failure: installedRead.error }
            : recoveredRead?.state === "failed"
              ? { status: "failed", bundleId, failure: recoveredRead.error }
              : installedRead?.state === "expired" ||
                  recoveredRead?.state === "expired"
                ? { status: "expired", bundleId, onRestart: restartDetail }
                : detailPublication && installedData && recoveredData
                  ? {
                      status: "success",
                      bundleId,
                      data: {
                        summary: detailPublication.summary,
                        series: {
                          installed: installedData,
                          recovered: recoveredData,
                        },
                      },
                      ...(detailRead?.state === "stale"
                        ? { staleAsOfMs: detailPublication.asOfMs }
                        : {}),
                    }
                  : { status: "loading", bundleId };

  const transportError = activeReport.error ?? overviewReport.error;
  const preparing =
    activeRead?.state === "preparing" || overviewRead?.state === "preparing";
  const failure =
    activeRead?.state === "failed"
      ? activeRead.error
      : overviewRead?.state === "failed"
        ? overviewRead.error
        : activeSeriesRead?.state === "failed"
          ? activeSeriesRead.error
          : distributionRead?.state === "failed"
            ? distributionRead.error
            : undefined;
  const expired =
    activeSeriesRead?.state === "expired" ||
    distributionRead?.state === "expired";
  const overviewLoading =
    activeReport.isLoading ||
    overviewReport.isLoading ||
    activeSeries.isLoading ||
    bundleDistribution.isLoading;
  const canShowOverview =
    activePublication !== undefined &&
    overviewPublication !== undefined &&
    activeSeriesData !== undefined &&
    distributionData !== undefined;
  const reportedBundles = distributionData
    ? getExactInsightsTotal(
        distributionData.total,
        distributionRead?.state === "ready"
          ? distributionRead.versions.sourceGeneration
          : null,
      )
    : null;
  const bundleSelector = (
    <div className="flex w-full min-w-0 flex-col gap-2 sm:max-w-md">
      <BundleSelector
        bundleId={bundleId}
        bundles={bundleOptions}
        onBundleChange={setSelectedBundleId}
      />
      {search.bundleBack?.length || distributionData?.hasNext ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            Bundle page {(search.bundleBack?.length ?? 0) + 1}
          </span>
          <div className="flex gap-2">
            <Button
              className="h-11 lg:h-7"
              disabled={!search.bundleBack?.length}
              onClick={() => {
                const previous = popInsightsCursor(search.bundleBack);
                setSelectedBundleId("");
                updateSearch({
                  bundleBack: previous.stack,
                  bundleCursor: previous.cursor,
                });
              }}
              size="sm"
              variant="outline"
            >
              Previous
            </Button>
            <Button
              className="h-11 lg:h-7"
              disabled={!distributionData?.nextCursor}
              onClick={() => {
                if (!distributionData?.nextCursor) return;
                setSelectedBundleId("");
                updateSearch({
                  bundleBack: pushInsightsCursor(
                    search.bundleBack,
                    search.bundleCursor,
                  ),
                  bundleCursor: distributionData.nextCursor,
                  bundlePublicationId:
                    distributionData.consistency.cutoff.publication.id,
                });
              }}
              size="sm"
              variant="outline"
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <InsightsPageHeader view="overview" />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 sm:gap-6">
          <InsightsControls onWindowChange={setWindow} window={window} />
          {activeRead?.state === "stale" && activePublication ? (
            <InsightsStaleNotice asOfMs={activePublication.asOfMs} />
          ) : null}
          {overviewRead?.state === "stale" && overviewPublication ? (
            <InsightsStaleNotice asOfMs={overviewPublication.asOfMs} />
          ) : null}
          {transportError ? (
            <InsightsOverview status="error" error={transportError} />
          ) : failure ? (
            <InsightsFailedState failure={failure} />
          ) : expired ? (
            <InsightsExpiredState
              onRestart={() => {
                updateSearch({
                  bundleBack: undefined,
                  bundleCursor: undefined,
                  bundlePublicationId: undefined,
                });
                setActiveMinAsOfMs(Date.now());
                setOverviewMinAsOfMs(Date.now());
              }}
            />
          ) : preparing ? (
            <InsightsPreparingState label="Preparing exact Insights" />
          ) : overviewLoading || !canShowOverview ? (
            <InsightsOverview status="loading" />
          ) : (
            <InsightsOverview
              active={{
                activeInstallations:
                  activePublication.summary.activeInstallations,
                asOfMs: activePublication.asOfMs,
                reportedBundles,
                series: activeSeriesData.data,
                window,
              }}
              bundleSelector={bundleSelector}
              configuredPercentage={configuredPercentage}
              latestBundleInstallations={
                bundleRows.find((row) => row.bundleId === bundleId)
                  ?.installations ?? 0
              }
              outcomes={outcomes}
              status="success"
              trackedInstallations={
                overviewPublication.summary.trackedInstallations
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
