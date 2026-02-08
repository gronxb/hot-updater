import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import dayjs from "dayjs";
import {
  Activity,
  ArrowRight,
  CheckCircle,
  Package,
  Radio,
  Smartphone,
  Users,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { AnalyticsShell } from "@/components/features/analytics/AnalyticsShell";
import { AppVersionDetailSheet } from "@/components/features/analytics/AppVersionDetailSheet";
import { BundleDetailSheet } from "@/components/features/analytics/BundleDetailSheet";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
    : analyticsEvents.slice(
        currentOffset,
        currentOffset + RECENT_ACTIVITY_LIMIT,
      );

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
          Bundle{" "}
          <span className="ml-1">
            <BundleIdDisplay bundleId={bundleId} />
          </span>
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

  const summaryStats = useMemo(() => {
    const uniqueDevices = new Set(analyticsEvents.map((e) => e.deviceId)).size;
    const totalPromoted = analyticsEvents.filter(
      (e) => e.eventType === "PROMOTED",
    ).length;
    const overallSuccessRate =
      analyticsEvents.length > 0
        ? (totalPromoted / analyticsEvents.length) * 100
        : 0;
    return {
      totalEvents: analyticsEvents.length,
      uniqueDevices,
      overallSuccessRate,
      activeBundles: bundles.length,
    };
  }, [analyticsEvents, bundles.length]);

  return (
    <AnalyticsShell title="Analytics Overview" chips={filterChips}>
      {/* Summary Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {isLoadingAnalytics ? (
          <>
            {[...Array(4)].map((_, i) => (
              <Card key={i} variant="outline">
                <CardHeader className="flex flex-row items-center justify-between p-4 pb-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-4 rounded" />
                </CardHeader>
                <CardContent className="p-4 pt-1">
                  <Skeleton className="h-7 w-16" />
                </CardContent>
              </Card>
            ))}
          </>
        ) : (
          <>
            <Card variant="outline">
              <CardHeader className="flex flex-row items-center justify-between p-4 pb-1">
                <CardDescription className="text-xs">
                  Total Events
                </CardDescription>
                <Activity className="h-3.5 w-3.5 text-muted-foreground/60" />
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <p className="text-2xl font-semibold tabular-nums">
                  {summaryStats.totalEvents.toLocaleString()}
                </p>
              </CardContent>
            </Card>
            <Card variant="outline">
              <CardHeader className="flex flex-row items-center justify-between p-4 pb-1">
                <CardDescription className="text-xs">
                  Unique Devices
                </CardDescription>
                <Users className="h-3.5 w-3.5 text-muted-foreground/60" />
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <p className="text-2xl font-semibold tabular-nums">
                  {summaryStats.uniqueDevices.toLocaleString()}
                </p>
              </CardContent>
            </Card>
            <Card variant="outline">
              <CardHeader className="flex flex-row items-center justify-between p-4 pb-1">
                <CardDescription className="text-xs">
                  Success Rate
                </CardDescription>
                <CheckCircle className="h-3.5 w-3.5 text-muted-foreground/60" />
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <p
                  className={`text-2xl font-semibold tabular-nums ${
                    summaryStats.overallSuccessRate >= 90
                      ? "text-success"
                      : summaryStats.overallSuccessRate >= 70
                        ? "text-warning"
                        : "text-error"
                  }`}
                >
                  {summaryStats.overallSuccessRate.toFixed(1)}%
                </p>
              </CardContent>
            </Card>
            <Card variant="outline">
              <CardHeader className="flex flex-row items-center justify-between p-4 pb-1">
                <CardDescription className="text-xs">
                  Active Bundles
                </CardDescription>
                <Package className="h-3.5 w-3.5 text-muted-foreground/60" />
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <p className="text-2xl font-semibold tabular-nums">
                  {summaryStats.activeBundles.toLocaleString()}
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* App Version & Bundle Distribution */}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card variant="editorial" className="flex flex-col">
          <CardHeader className="flex flex-row items-start justify-between p-5 pb-0">
            <div className="space-y-1">
              <CardTitle className="text-sm font-semibold">
                App Version Compatibility
              </CardTitle>
              <CardDescription className="text-xs">
                Top app versions by event volume
              </CardDescription>
            </div>
            <Link to="/analytics/app-versions" search={{ version: undefined }}>
              <Button variant="quiet" size="sm" className="gap-1 -mt-0.5">
                Details <ArrowRight className="h-3 w-3" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="flex-1 p-5 pt-4">
            {isLoadingAnalytics ? (
              <SkeletonList
                count={5}
                className="h-9 w-full"
                containerClassName="space-y-2"
              />
            ) : appVersionData.length === 0 ? (
              <div className="flex h-[220px] flex-col items-center justify-center text-center">
                <Smartphone className="h-8 w-8 text-muted-foreground/40" />
                <p className="mt-3 text-sm text-muted-foreground">
                  No app version data
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {appVersionData.map((version) => (
                  <button
                    type="button"
                    key={version.appVersion}
                    onClick={() => handleVersionClick(version.appVersion)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--raised-surface)] ${
                      version.successRate < 90
                        ? "bg-warning-muted/30 border border-warning-border/40"
                        : "border border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-xs font-medium truncate">
                        {version.appVersion}
                      </span>
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
          </CardContent>
        </Card>

        <Card variant="editorial" className="flex flex-col">
          <CardHeader className="flex flex-row items-start justify-between p-5 pb-0">
            <div className="space-y-1">
              <CardTitle className="text-sm font-semibold">
                Bundle Event Distribution
              </CardTitle>
              <CardDescription className="text-xs">
                Top bundles by event volume
              </CardDescription>
            </div>
            <Link to="/analytics/bundles" search={{ bundle: undefined }}>
              <Button variant="quiet" size="sm" className="gap-1 -mt-0.5">
                Details <ArrowRight className="h-3 w-3" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="flex-1 p-5 pt-4">
            {isLoadingAnalytics ? (
              <SkeletonList
                count={5}
                className="h-9 w-full"
                containerClassName="space-y-2"
              />
            ) : bundleData.length === 0 ? (
              <div className="flex h-[220px] flex-col items-center justify-center text-center">
                <Package className="h-8 w-8 text-muted-foreground/40" />
                <p className="mt-3 text-sm text-muted-foreground">
                  No bundle data
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {bundleData.map((bundle) => (
                  <button
                    type="button"
                    key={bundle.bundleId}
                    onClick={() => handleBundleClick(bundle.bundleId)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--raised-surface)] ${
                      bundle.successRate < 90
                        ? "bg-warning-muted/30 border border-warning-border/40"
                        : "border border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-[0.68rem] truncate max-w-[180px]">
                        {bundle.bundleId}
                      </span>
                      <span className="text-[0.68rem] text-muted-foreground tabular-nums">
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
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <Card variant="editorial" className="overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between p-5 pb-0">
          <div className="space-y-1">
            <CardTitle className="text-sm font-semibold">
              Recent Activity
            </CardTitle>
            <CardDescription className="text-xs">
              Device event timeline
            </CardDescription>
          </div>
          <Link to="/analytics/activity">
            <Button variant="quiet" size="sm" className="gap-1 -mt-0.5">
              All Devices <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </CardHeader>
        <CardContent className="p-0 pt-4">
          {isLoadingRecentActivity ? (
            <div className="space-y-4 px-5 pb-5">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center space-x-4">
                  <Skeleton className="h-10 w-10 rounded-full shrink-0" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-[250px]" />
                    <Skeleton className="h-3 w-[200px]" />
                  </div>
                </div>
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="py-12 text-center">
              <Radio className="mx-auto h-8 w-8 text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">
                No events found
              </p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-[var(--panel-border)]">
                {events.map((event: any) => (
                  <div
                    key={event.id || event.createdAt}
                    className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-[var(--raised-surface)]/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={getEventTypeVariant(event.eventType)}>
                          {event.eventType.toLowerCase()}
                        </Badge>
                        <PlatformIcon
                          platform={event.platform}
                          className="h-3.5 w-3.5 text-muted-foreground"
                        />
                        <span
                          className="max-w-[200px] truncate font-mono text-[0.68rem] text-muted-foreground"
                          title={event.deviceId}
                        >
                          {event.deviceId}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.68rem] text-muted-foreground">
                        <BundleIdDisplay bundleId={event.bundleId} />
                        {event.appVersion ? (
                          <span className="font-mono">v{event.appVersion}</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
                      <ChannelBadge channel={event.channel} />
                      <span className="text-[0.65rem] text-muted-foreground whitespace-nowrap tabular-nums">
                        {event.createdAt
                          ? dayjs(event.createdAt).format("MM/DD HH:mm")
                          : "—"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <Separator />
              <div className="flex items-center justify-between px-5 py-3 bg-[var(--raised-surface)]/40">
                <p className="text-[0.68rem] text-muted-foreground tabular-nums">
                  {currentOffset + 1}–
                  {Math.min(currentOffset + events.length, totalEvents)} of{" "}
                  {totalEvents}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePreviousPage}
                    disabled={!hasPreviousPage}
                    aria-label="Go to previous page"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
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
        </CardContent>
      </Card>

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
