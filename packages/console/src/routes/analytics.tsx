import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import dayjs from "dayjs";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Package,
  Radio,
  RotateCcw,
  Smartphone,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { AppVersionDetailSheet } from "@/components/features/analytics/AppVersionDetailSheet";
import { BundleDetailSheet } from "@/components/features/analytics/BundleDetailSheet";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeviceEventsQuery } from "@/lib/api";
import { useAnalyticsAggregation } from "@/hooks/useAnalyticsAggregation";
import { ANALYTICS_EVENTS_LIMIT } from "@/lib/constants";
import {
  getEventTypeVariant,
  getSuccessRateVariant,
} from "@/lib/status-utils";

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
  const [versionSortBy, setVersionSortBy] = useState<"total" | "failureRate">(
    "total",
  );
  const [bundleSortBy, setBundleSortBy] = useState<"total" | "failureRate">(
    "total",
  );

  // Memoized callbacks to prevent child component re-renders
  const handleVersionSheetChange = useCallback((open: boolean) => {
    if (!open) setSelectedVersion(null);
  }, []);

  const handleBundleSheetChange = useCallback((open: boolean) => {
    if (!open) setSelectedBundleId(null);
  }, []);

  const handleVersionClick = useCallback((version: string) => {
    setSelectedVersion(version);
  }, []);

  const handleBundleClick = useCallback((bundleId: string) => {
    setSelectedBundleId(bundleId);
  }, []);

  // Fetch data for analytics aggregation (1000 events)
  const { data: analyticsData, isLoading: isLoadingAnalytics } =
    useDeviceEventsQuery({
      bundleId,
      platform,
      channel,
      limit: ANALYTICS_EVENTS_LIMIT,
      offset: 0,
    });

  // Only fetch additional data if paginating beyond analytics data
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

  // Use analytics data for recent activity when within range, otherwise use paginated data
  const events = needsAdditionalFetch
    ? (eventsData?.data ?? [])
    : analyticsEvents.slice(currentOffset, currentOffset + RECENT_ACTIVITY_LIMIT);

  const totalEvents = analyticsData?.pagination.total ?? 0;
  const isLoadingRecentActivity = needsAdditionalFetch
    ? isLoadingEvents
    : isLoadingAnalytics;

  // Use shared aggregation hook to compute once instead of separately
  const { appVersions, bundles } = useAnalyticsAggregation(analyticsEvents);

  const appVersionData = useMemo(() => {
    if (versionSortBy === "failureRate") {
      return [...appVersions]
        .sort((a, b) => a.successRate - b.successRate)
        .slice(0, 5);
    }
    return appVersions.slice(0, 5);
  }, [appVersions, versionSortBy]);

  const bundleData = useMemo(() => {
    if (bundleSortBy === "failureRate") {
      return [...bundles].sort((a, b) => a.successRate - b.successRate).slice(0, 5);
    }
    return bundles.slice(0, 5);
  }, [bundles, bundleSortBy]);

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

  return (
    <div className="flex flex-col h-full bg-background min-h-screen">
      <header className="flex h-12 shrink-0 items-center gap-[var(--spacing-element)] border-b px-[var(--spacing-component)] bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <SidebarTrigger className="-ml-1" />
        <h1 className="text-[length:var(--text-h1)] font-semibold ml-[var(--spacing-element)]">
          Analytics Overview
        </h1>
        {bundleId && (
          <div className="flex items-center gap-[var(--spacing-element)] text-[length:var(--text-body)] text-muted-foreground ml-[var(--spacing-element)]">
            <span>Bundle:</span>
            <BundleIdDisplay bundleId={bundleId} />
          </div>
        )}
      </header>

      <div className="flex-1 overflow-auto p-[var(--spacing-section)] space-y-[var(--spacing-section)]">
        <div className="grid gap-[var(--spacing-section)] md:grid-cols-2">
          <Card variant="subtle">
            <CardHeader className="pb-[var(--spacing-component)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-[var(--spacing-element)]">
                  <Smartphone className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-[length:var(--text-h3)] font-semibold">
                    App Version Compatibility
                  </CardTitle>
                </div>
                <Link
                  to="/analytics/app-versions"
                  search={{ version: undefined }}
                >
                  <Button variant="ghost" size="sm" className="h-8 gap-[var(--spacing-tight)]">
                    View Details
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
              <div className="flex items-center justify-between mt-[var(--spacing-element)]">
                <p className="text-[length:var(--text-small)] text-muted-foreground">
                  {versionSortBy === "failureRate"
                    ? "Top 5 by failure rate"
                    : "Top 5 by volume"}
                </p>
                <Select
                  value={versionSortBy}
                  onValueChange={(v) =>
                    setVersionSortBy(v as "total" | "failureRate")
                  }
                >
                  <SelectTrigger className="h-7 w-[130px] text-[length:var(--text-small)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="total">By Volume</SelectItem>
                    <SelectItem value="failureRate">Problems First</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {isLoadingAnalytics ? (
                <div className="space-y-[var(--spacing-element)]">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : appVersionData.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[200px] text-center" role="status" aria-live="polite">
                  <div className="h-12 w-12 rounded-full bg-muted/30 flex items-center justify-center mb-[var(--spacing-component)]">
                    <Smartphone className="h-6 w-6 text-muted-foreground/50" />
                  </div>
                  <h3 className="text-[length:var(--text-body)] font-medium text-foreground mb-[var(--spacing-tight)]">
                    No app version data
                  </h3>
                  <p className="text-[length:var(--text-small)] text-muted-foreground max-w-[400px]">
                    Data will appear here once devices interact with updates
                  </p>
                </div>
              ) : (
                <div className="space-y-[var(--spacing-component)]">
                  {appVersionData.map((version) => (
                    <button
                      type="button"
                      key={version.appVersion}
                      onClick={() => handleVersionClick(version.appVersion)}
                      className={`flex items-center justify-between w-full p-[var(--spacing-element)] -mx-[var(--spacing-element)] rounded-md hover:bg-muted/50 transition-colors cursor-pointer text-left ${version.successRate < 90 ? "bg-warning-muted/30" : ""}`}
                    >
                      <div className="flex items-center gap-[var(--spacing-element)]">
                        <span className="font-mono text-[length:var(--text-body)]">
                          {version.appVersion}
                        </span>
                      </div>
                      <div className="flex items-center gap-[var(--spacing-element)]">
                        <Badge
                          variant={getSuccessRateVariant(version.successRate)}
                        >
                          {version.successRate.toFixed(0)}%
                        </Badge>
                        <span className="text-[length:var(--text-small)] text-muted-foreground w-16 text-right">
                          {version.total.toLocaleString()} events
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card variant="subtle">
            <CardHeader className="pb-[var(--spacing-component)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-[var(--spacing-element)]">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-[length:var(--text-h3)] font-semibold">
                    Bundle Event Distribution
                  </CardTitle>
                </div>
                <Link to="/analytics/bundles" search={{ bundle: undefined }}>
                  <Button variant="ghost" size="sm" className="h-8 gap-[var(--spacing-tight)]">
                    View Details
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
              <div className="flex items-center justify-between mt-[var(--spacing-element)]">
                <p className="text-[length:var(--text-small)] text-muted-foreground">
                  {bundleSortBy === "failureRate"
                    ? "Top 5 by failure rate"
                    : "Top 5 by volume"}
                </p>
                <Select
                  value={bundleSortBy}
                  onValueChange={(v) =>
                    setBundleSortBy(v as "total" | "failureRate")
                  }
                >
                  <SelectTrigger className="h-7 w-[130px] text-[length:var(--text-small)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="total">By Volume</SelectItem>
                    <SelectItem value="failureRate">Problems First</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {isLoadingAnalytics ? (
                <div className="space-y-[var(--spacing-element)]">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : bundleData.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[200px] text-center" role="status" aria-live="polite">
                  <div className="h-12 w-12 rounded-full bg-muted/30 flex items-center justify-center mb-[var(--spacing-component)]">
                    <Package className="h-6 w-6 text-muted-foreground/50" />
                  </div>
                  <h3 className="text-[length:var(--text-body)] font-medium text-foreground mb-[var(--spacing-tight)]">
                    No bundle data
                  </h3>
                  <p className="text-[length:var(--text-small)] text-muted-foreground max-w-[400px]">
                    Data will appear here once bundles are deployed
                  </p>
                </div>
              ) : (
                <div className="space-y-[var(--spacing-component)]">
                  {bundleData.map((bundle) => (
                    <button
                      type="button"
                      key={bundle.bundleId}
                      onClick={() => handleBundleClick(bundle.bundleId)}
                      className={`flex items-center justify-between w-full p-[var(--spacing-element)] -mx-[var(--spacing-element)] rounded-md hover:bg-muted/50 transition-colors cursor-pointer text-left ${bundle.successRate < 90 ? "bg-warning-muted/30" : ""}`}
                    >
                      <div className="flex items-center gap-[var(--spacing-element)]">
                        <span className="font-mono text-[length:var(--text-small)] truncate max-w-[140px]">
                          {bundle.bundleId}
                        </span>
                        <span className="text-[length:var(--text-small)] text-muted-foreground">
                          {bundle.deviceCount} devices
                        </span>
                      </div>
                      <div className="flex items-center gap-[var(--spacing-component)] text-[length:var(--text-small)]">
                        <Badge
                          variant={getSuccessRateVariant(bundle.successRate)}
                        >
                          {bundle.successRate.toFixed(0)}%
                        </Badge>
                        <span className="text-muted-foreground w-12 text-right">
                          {bundle.total} total
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-[var(--spacing-component)]">
          <div className="flex items-center justify-between">
            <h2 className="text-[length:var(--text-h2)] font-semibold tracking-tight">
              Recent Activity
            </h2>
            <Link to="/analytics/activity">
              <Button variant="ghost" size="sm" className="h-8 gap-[var(--spacing-tight)]">
                View All Devices
                <ArrowRight className="h-3 w-3" />
              </Button>
            </Link>
          </div>

          <Card variant="subtle">
            {isLoadingRecentActivity ? (
              <CardContent className="p-[var(--spacing-component)]">
                <div className="space-y-[var(--spacing-component)]">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="flex items-center space-x-[var(--spacing-component)]">
                      <Skeleton className="h-10 w-10 rounded-full" />
                      <div className="space-y-[var(--spacing-element)] flex-1">
                        <Skeleton className="h-4 w-[250px]" />
                        <Skeleton className="h-4 w-[200px]" />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            ) : events.length === 0 ? (
              <CardContent className="py-12">
                <div className="flex flex-col items-center justify-center text-center" role="status" aria-live="polite">
                  <div className="h-16 w-16 rounded-full bg-muted/30 flex items-center justify-center mb-[var(--spacing-component)]">
                    <Radio className="h-8 w-8 text-muted-foreground/50" />
                  </div>
                  <h3 className="text-[length:var(--text-h3)] font-medium text-foreground mb-[var(--spacing-element)]">
                    No events found
                  </h3>
                  <p className="text-[length:var(--text-body)] text-muted-foreground max-w-[400px]">
                    No device events match your current filters. Events will
                    appear here as devices interact with your updates.
                  </p>
                </div>
              </CardContent>
            ) : (
              <>
                <div className="divide-y divide-border/50">
                  {events.map((event: any) => (
                    <div
                      key={event.id || event.createdAt}
                      className="flex flex-col sm:flex-row sm:items-center gap-[var(--spacing-component)] p-[var(--spacing-component)] hover:bg-muted/30 transition-colors group"
                    >
                      <div className="flex-shrink-0">
                        <div
                          className={`
                          flex h-10 w-10 items-center justify-center rounded-full border bg-background/50
                          ${event.eventType === "PROMOTED" ? "border-event-promoted-border text-success" : "border-event-recovered-border text-[color:var(--event-recovered)]"}
                        `}
                        >
                          {event.eventType === "PROMOTED" ? (
                            <ArrowUpRight className="h-5 w-5" />
                          ) : (
                            <RotateCcw className="h-5 w-5" />
                          )}
                        </div>
                      </div>

                      <div className="flex-1 min-w-0 space-y-[var(--spacing-tight)]">
                        <div className="flex items-center gap-[var(--spacing-element)] flex-wrap">
                          <Badge
                            variant={getEventTypeVariant(event.eventType)}
                            className="capitalize font-medium"
                          >
                            {event.eventType.toLowerCase()}
                          </Badge>
                          <span
                            className="text-[length:var(--text-body)] font-mono text-muted-foreground truncate max-w-[250px]"
                            title={event.deviceId}
                          >
                            {event.deviceId}
                          </span>
                          <PlatformIcon
                            platform={event.platform}
                            className="h-4 w-4 text-muted-foreground"
                          />
                        </div>

                        <div className="flex items-center gap-[var(--spacing-component)] text-[length:var(--text-small)] text-muted-foreground">
                          <div className="flex items-center gap-[var(--spacing-tight)]">
                            <span className="opacity-70">Bundle:</span>
                            <BundleIdDisplay bundleId={event.bundleId} />
                          </div>
                          {event.appVersion && (
                            <div className="flex items-center gap-[var(--spacing-tight)] border-l pl-[var(--spacing-component)] border-border/50">
                              <span className="opacity-70">App v:</span>
                              <span className="font-mono">
                                {event.appVersion}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex sm:flex-col items-center sm:items-end gap-[var(--spacing-element)] sm:gap-[var(--spacing-tight)] text-right ml-auto pl-[var(--spacing-component)]">
                        <ChannelBadge channel={event.channel} />
                        <span className="text-[length:var(--text-small)] text-muted-foreground whitespace-nowrap">
                          {event.createdAt
                            ? dayjs(event.createdAt).format(
                                "YYYY/MM/DD HH:mm:ss",
                              )
                            : "Unknown time"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between px-[var(--spacing-component)] py-[var(--spacing-component)] border-t bg-muted/30">
                  <div className="text-[length:var(--text-small)] text-muted-foreground font-medium">
                    Showing{" "}
                    <span className="text-foreground font-semibold">{currentOffset + 1}</span>{" "}
                    to{" "}
                    <span className="text-foreground font-semibold">
                      {Math.min(currentOffset + events.length, totalEvents)}
                    </span>{" "}
                    of <span className="text-foreground font-semibold">{totalEvents}</span>{" "}
                    entries
                  </div>
                  <div className="flex items-center gap-[var(--spacing-element)]">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePreviousPage}
                      disabled={!hasPreviousPage}
                      aria-label="Go to previous page"
                    >
                      <ChevronLeft className="h-4 w-4 mr-[var(--spacing-tight)]" />
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
                      <ChevronRight className="h-4 w-4 ml-[var(--spacing-tight)]" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>

      <AppVersionDetailSheet
        selectedVersion={selectedVersion}
        onOpenChange={handleVersionSheetChange}
        analyticsEvents={analyticsEvents}
      />

      <BundleDetailSheet
        selectedBundle={selectedBundleId}
        onOpenChange={handleBundleSheetChange}
        analyticsEvents={analyticsEvents}
      />
    </div>
  );
}
