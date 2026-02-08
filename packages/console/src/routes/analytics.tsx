import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import dayjs from "dayjs";
import {
  ArrowRight,
  ArrowUpRight,
  Package,
  Radio,
  RotateCcw,
  Smartphone,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { AnalyticsSection } from "@/components/features/analytics/AnalyticsSection";
import { AnalyticsShell } from "@/components/features/analytics/AnalyticsShell";
import { AppVersionDetailSheet } from "@/components/features/analytics/AppVersionDetailSheet";
import { BundleDetailSheet } from "@/components/features/analytics/BundleDetailSheet";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useAnalyticsAggregation } from "@/hooks/useAnalyticsAggregation";
import { useDeviceEventsQuery } from "@/lib/api";
import { ANALYTICS_EVENTS_LIMIT } from "@/lib/constants";
import { getEventTypeVariant, getSuccessRateVariant } from "@/lib/status-utils";

const RECENT_ACTIVITY_LIMIT = 10;

export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      bundleId: search.bundleId as string | undefined,
      platform: search.platform as "ios" | "android" | undefined,
      channel: search.channel as string | undefined,
      offset: search.offset as string | undefined,
    };
  },
});

function AnalyticsPage() {
  const { bundleId, platform, channel, offset } = Route.useSearch();
  const navigate = useNavigate();
  const currentOffset = Number(offset || 0);

  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);

  const handleVersionSheetChange = useCallback((open: boolean) => {
    if (!open) setSelectedVersion(null);
  }, []);

  const handleBundleSheetChange = useCallback((open: boolean) => {
    if (!open) setSelectedBundleId(null);
  }, []);

  const handleVersionClick = useCallback((version: string) => {
    setSelectedVersion(version);
  }, []);

  const handleBundleClick = useCallback((clickedBundleId: string) => {
    setSelectedBundleId(clickedBundleId);
  }, []);

  const { data: analyticsData, isLoading: isLoadingAnalytics } =
    useDeviceEventsQuery({
      bundleId,
      platform,
      channel,
      limit: ANALYTICS_EVENTS_LIMIT,
      offset: 0,
    });

  const needsAdditionalFetch = currentOffset >= ANALYTICS_EVENTS_LIMIT;
  const { data: eventsData, isLoading: isLoadingEvents } = useDeviceEventsQuery(
    {
      bundleId,
      platform,
      channel,
      limit: RECENT_ACTIVITY_LIMIT,
      offset: currentOffset,
    },
    {
      enabled: needsAdditionalFetch,
    },
  );

  const analyticsEvents = analyticsData?.data ?? [];

  const events = needsAdditionalFetch
    ? (eventsData?.data ?? [])
    : analyticsEvents.slice(currentOffset, currentOffset + RECENT_ACTIVITY_LIMIT);

  const totalEvents = analyticsData?.pagination.total ?? 0;
  const isLoadingRecentActivity = needsAdditionalFetch
    ? isLoadingEvents
    : isLoadingAnalytics;

  const { appVersions, bundles, appVersionMap, bundleMap, versionBundlesMap } =
    useAnalyticsAggregation(analyticsEvents);

  const appVersionData = useMemo(() => {
    return appVersions.slice(0, 5);
  }, [appVersions]);

  const bundleData = useMemo(() => {
    return bundles.slice(0, 5);
  }, [bundles]);

  const handlePreviousPage = () => {
    const newOffset = Math.max(0, currentOffset - RECENT_ACTIVITY_LIMIT);
    void navigate({
      to: "/analytics",
      search: {
        bundleId,
        platform,
        channel,
        offset: newOffset.toString(),
      },
    });
  };

  const handleNextPage = () => {
    const newOffset = currentOffset + RECENT_ACTIVITY_LIMIT;
    void navigate({
      to: "/analytics",
      search: {
        bundleId,
        platform,
        channel,
        offset: newOffset.toString(),
      },
    });
  };

  const hasNextPage = eventsData?.pagination.hasNextPage ?? false;
  const hasPreviousPage = currentOffset > 0;

  const filterChips = (
    <>
      {bundleId ? (
        <Badge variant="outline" className="font-mono text-[0.68rem]">
          Bundle <span className="ml-1"><BundleIdDisplay bundleId={bundleId} /></span>
        </Badge>
      ) : null}
      {platform ? (
        <Badge variant="outline" className="text-[0.68rem]">
          Platform {platform}
        </Badge>
      ) : null}
      {channel ? (
        <Badge variant="outline" className="text-[0.68rem]">
          Channel {channel}
        </Badge>
      ) : null}
    </>
  );

  return (
    <AnalyticsShell title="Analytics Overview" chips={filterChips}>
      <div className="grid gap-6 xl:grid-cols-2">
        <AnalyticsSection
          title="App Version Compatibility"
          description="Top app versions by event volume."
          className="h-full"
          action={
            <div className="flex items-center gap-2">
              <Link to="/analytics/app-versions" search={{ version: undefined }}>
                <Button variant="quiet" size="sm" className="gap-1">
                  Details <ArrowRight className="h-3 w-3" />
                </Button>
              </Link>
            </div>
          }
        >
          <Card variant="editorial" className="p-4 h-full min-h-[280px]">
            {isLoadingAnalytics ? (
              <SkeletonList
                count={5}
                className="h-8 w-full"
                containerClassName="space-y-[var(--spacing-element)]"
              />
            ) : appVersionData.length === 0 ? (
              <div className="flex h-[220px] flex-col items-center justify-center text-center">
                <Smartphone className="h-8 w-8 text-muted-foreground/60" />
                <p className="mt-2 text-sm text-muted-foreground">No app version data</p>
              </div>
            ) : (
              <div className="space-y-2">
                {appVersionData.map((version) => (
                  <button
                    type="button"
                    key={version.appVersion}
                    onClick={() => handleVersionClick(version.appVersion)}
                    className={`flex w-full items-center justify-between rounded-md border border-transparent px-3 py-2 text-left hover:bg-[var(--raised-surface)] ${
                      version.successRate < 90 ? "bg-warning-muted/30" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-xs truncate">{version.appVersion}</span>
                      <span className="text-[0.68rem] text-muted-foreground tabular-nums">
                        {version.total.toLocaleString()} events
                      </span>
                    </div>
                    <Badge variant={getSuccessRateVariant(version.successRate)}>
                      {version.successRate.toFixed(0)}%
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </AnalyticsSection>

        <AnalyticsSection
          title="Bundle Event Distribution"
          description="Top bundles by event volume."
          className="h-full"
          action={
            <div className="flex items-center gap-2">
              <Link to="/analytics/bundles" search={{ bundle: undefined }}>
                <Button variant="quiet" size="sm" className="gap-1">
                  Details <ArrowRight className="h-3 w-3" />
                </Button>
              </Link>
            </div>
          }
        >
          <Card variant="editorial" className="p-4 h-full min-h-[280px]">
            {isLoadingAnalytics ? (
              <SkeletonList
                count={5}
                className="h-8 w-full"
                containerClassName="space-y-[var(--spacing-element)]"
              />
            ) : bundleData.length === 0 ? (
              <div className="flex h-[220px] flex-col items-center justify-center text-center">
                <Package className="h-8 w-8 text-muted-foreground/60" />
                <p className="mt-2 text-sm text-muted-foreground">No bundle data</p>
              </div>
            ) : (
              <div className="space-y-2">
                {bundleData.map((bundle) => (
                  <button
                    type="button"
                    key={bundle.bundleId}
                    onClick={() => handleBundleClick(bundle.bundleId)}
                    className={`flex w-full items-center justify-between rounded-md border border-transparent px-3 py-2 text-left hover:bg-[var(--raised-surface)] ${
                      bundle.successRate < 90 ? "bg-warning-muted/30" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[0.68rem] truncate max-w-[180px]">
                        {bundle.bundleId}
                      </span>
                      <span className="text-[0.68rem] text-muted-foreground">
                        {bundle.deviceCount} devices
                      </span>
                    </div>
                    <Badge variant={getSuccessRateVariant(bundle.successRate)}>
                      {bundle.successRate.toFixed(0)}%
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </AnalyticsSection>
      </div>

      <AnalyticsSection
        title="Recent Activity"
        description="Device event timeline."
        action={
          <Link to="/analytics/activity">
            <Button variant="quiet" size="sm" className="gap-1">
              All Devices <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        }
      >
        <Card variant="editorial" className="overflow-hidden">
          {isLoadingRecentActivity ? (
            <div className="space-y-4 p-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center space-x-4">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-[250px]" />
                    <Skeleton className="h-4 w-[200px]" />
                  </div>
                </div>
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="py-12 text-center">
              <Radio className="mx-auto h-8 w-8 text-muted-foreground/60" />
              <p className="mt-2 text-sm text-muted-foreground">No events found</p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-[var(--panel-border)]">
                {events.map((event: any) => (
                  <div
                    key={event.id || event.createdAt}
                    className="group flex flex-col gap-3 p-4 sm:flex-row sm:items-center hover:bg-[var(--raised-surface)]"
                  >
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-background/40 ${
                        event.eventType === "PROMOTED"
                          ? "border-event-promoted-border text-success"
                          : "border-event-recovered-border text-[color:var(--event-recovered)]"
                      }`}
                    >
                      {event.eventType === "PROMOTED" ? (
                        <ArrowUpRight className="h-5 w-5" />
                      ) : (
                        <RotateCcw className="h-5 w-5" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={getEventTypeVariant(event.eventType)}>
                          {event.eventType.toLowerCase()}
                        </Badge>
                        <span
                          className="max-w-[250px] truncate font-mono text-xs text-muted-foreground"
                          title={event.deviceId}
                        >
                          {event.deviceId}
                        </span>
                        <PlatformIcon
                          platform={event.platform}
                          className="h-4 w-4 text-muted-foreground"
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-[0.7rem] text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <span className="opacity-70">Bundle:</span>
                          <BundleIdDisplay bundleId={event.bundleId} />
                        </div>
                        {event.appVersion ? (
                          <div className="flex items-center gap-1 border-l border-border/50 pl-3">
                            <span className="opacity-70">App v:</span>
                            <span className="font-mono">{event.appVersion}</span>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="ml-auto flex items-center gap-2 sm:flex-col sm:items-end">
                      <ChannelBadge channel={event.channel} />
                      <span className="text-[0.68rem] text-muted-foreground whitespace-nowrap">
                        {event.createdAt
                          ? dayjs(event.createdAt).format("YYYY/MM/DD HH:mm:ss")
                          : "Unknown time"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between border-t border-[var(--panel-border)] bg-[var(--raised-surface)]/60 px-4 py-3">
                <div className="text-[0.7rem] text-muted-foreground">
                  Showing {currentOffset + 1} to {Math.min(currentOffset + events.length, totalEvents)} of {totalEvents}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="panel"
                    size="sm"
                    onClick={handlePreviousPage}
                    disabled={!hasPreviousPage}
                    aria-label="Go to previous page"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="panel"
                    size="sm"
                    onClick={handleNextPage}
                    disabled={!hasNextPage}
                    aria-label="Go to next page"
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      </AnalyticsSection>

      <AppVersionDetailSheet
        selectedVersion={selectedVersion}
        onOpenChange={handleVersionSheetChange}
        analyticsEvents={analyticsEvents}
        appVersionMap={appVersionMap}
        versionBundlesMap={versionBundlesMap}
      />

      <BundleDetailSheet
        selectedBundle={selectedBundleId}
        onOpenChange={handleBundleSheetChange}
        analyticsEvents={analyticsEvents}
        bundleMap={bundleMap}
      />
    </AnalyticsShell>
  );
}
