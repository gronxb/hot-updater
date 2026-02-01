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
import { useMemo, useState } from "react";
import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { AppVersionDetailSheet } from "@/components/features/analytics/AppVersionDetailSheet";
import { BundleDetailSheet } from "@/components/features/analytics/BundleDetailSheet";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { aggregateByAppVersion } from "@/lib/analytics-utils";
import { useDeviceEventsQuery } from "@/lib/api";
import { ANALYTICS_EVENTS_LIMIT } from "@/lib/constants";

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

  const { data: analyticsData, isLoading: isLoadingAnalytics } =
    useDeviceEventsQuery({
      bundleId,
      platform,
      channel,
      limit: ANALYTICS_EVENTS_LIMIT,
      offset: 0,
    });

  const { data: eventsData, isLoading: isLoadingEvents } = useDeviceEventsQuery(
    {
      bundleId,
      platform,
      channel,
      limit: RECENT_ACTIVITY_LIMIT,
      offset: currentOffset,
    },
  );

  const events = eventsData?.data ?? [];
  const totalEvents = eventsData?.pagination.total ?? 0;
  const analyticsEvents = analyticsData?.data ?? [];

  const appVersionData = useMemo(
    () => aggregateByAppVersion(analyticsEvents).slice(0, 5),
    [analyticsEvents],
  );

  type BundleEventCount = {
    bundleId: string;
    promoted: number;
    recovered: number;
    total: number;
  };

  const bundleData = useMemo(() => {
    const counts: Record<string, BundleEventCount> = {};
    for (const event of analyticsEvents) {
      const bId = event.bundleId;
      if (!counts[bId]) {
        counts[bId] = {
          bundleId: bId,
          promoted: 0,
          recovered: 0,
          total: 0,
        };
      }
      if (event.eventType === "PROMOTED") {
        counts[bId].promoted += 1;
      } else if (event.eventType === "RECOVERED") {
        counts[bId].recovered += 1;
      }
      counts[bId].total += 1;
    }
    return Object.values(counts)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
  }, [analyticsEvents]);

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
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <SidebarTrigger className="-ml-1" />
        <h1 className="text-lg font-semibold ml-2">Analytics Overview</h1>
        {bundleId && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground ml-2">
            <span>Bundle:</span>
            <BundleIdDisplay bundleId={bundleId} />
          </div>
        )}
      </header>

      <div className="flex-1 overflow-auto p-6 space-y-6">
        <div className="grid gap-6 md:grid-cols-2">
          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base font-semibold">
                    App Version Compatibility
                  </CardTitle>
                </div>
                <Link
                  to="/analytics/app-versions"
                  search={{ version: undefined }}
                >
                  <Button variant="ghost" size="sm" className="h-8 gap-1">
                    View Details
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
              <p className="text-xs text-muted-foreground">
                Top 5 app versions by event count
              </p>
            </CardHeader>
            <CardContent>
              {isLoadingAnalytics ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : appVersionData.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[200px] text-center">
                  <Smartphone className="h-8 w-8 mb-2 opacity-20 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No app version data
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {appVersionData.map((version) => (
                    <button
                      type="button"
                      key={version.appVersion}
                      onClick={() => setSelectedVersion(version.appVersion)}
                      className="flex items-center justify-between w-full p-2 -mx-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">
                          {version.appVersion}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={
                            version.successRate >= 90
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                              : version.successRate >= 70
                                ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20"
                                : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
                          }
                        >
                          {version.successRate.toFixed(0)}%
                        </Badge>
                        <span className="text-xs text-muted-foreground w-16 text-right">
                          {version.total.toLocaleString()} events
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base font-semibold">
                    Bundle Event Distribution
                  </CardTitle>
                </div>
                <Link to="/analytics/bundles" search={{ bundle: undefined }}>
                  <Button variant="ghost" size="sm" className="h-8 gap-1">
                    View Details
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
              <p className="text-xs text-muted-foreground">
                Top 5 bundles by event count
              </p>
            </CardHeader>
            <CardContent>
              {isLoadingAnalytics ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : bundleData.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[200px] text-center">
                  <Package className="h-8 w-8 mb-2 opacity-20 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No bundle data
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {bundleData.map((bundle) => (
                    <button
                      type="button"
                      key={bundle.bundleId}
                      onClick={() => setSelectedBundleId(bundle.bundleId)}
                      className="flex items-center justify-between w-full p-2 -mx-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs truncate max-w-[140px]">
                          {bundle.bundleId}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {bundle.promoted}
                        </span>
                        <span className="text-muted-foreground">/</span>
                        <span className="text-orange-600 dark:text-orange-400">
                          {bundle.recovered}
                        </span>
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

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight">
              Recent Activity
            </h2>
            <Link to="/analytics/activity">
              <Button variant="ghost" size="sm" className="h-8 gap-1">
                View All Devices
                <ArrowRight className="h-3 w-3" />
              </Button>
            </Link>
          </div>

          <div className="rounded-md border border-border/50 bg-card/50 backdrop-blur-sm shadow-sm overflow-hidden">
            {isLoadingEvents ? (
              <div className="p-4 space-y-4">
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
              <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                <Radio className="h-12 w-12 mb-4 opacity-20" />
                <h3 className="text-lg font-medium text-foreground">
                  No events found
                </h3>
                <p className="text-sm max-w-[400px] mt-2">
                  No device events match your current filters. Events will
                  appear here as devices interact with your updates.
                </p>
              </div>
            ) : (
              <>
                <div className="divide-y divide-border/50">
                  {events.map((event: any) => (
                    <div
                      key={event.id || event.createdAt}
                      className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 hover:bg-muted/30 transition-colors group"
                    >
                      <div className="flex-shrink-0">
                        <div
                          className={`
                          flex h-10 w-10 items-center justify-center rounded-full border bg-background/50
                          ${event.eventType === "PROMOTED" ? "border-emerald-500/20 text-emerald-500" : "border-orange-500/20 text-orange-500"}
                        `}
                        >
                          {event.eventType === "PROMOTED" ? (
                            <ArrowUpRight className="h-5 w-5" />
                          ) : (
                            <RotateCcw className="h-5 w-5" />
                          )}
                        </div>
                      </div>

                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant="outline"
                            className={`
                              capitalize font-medium border
                              ${
                                event.eventType === "PROMOTED"
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                                  : "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20"
                              }
                            `}
                          >
                            {event.eventType.toLowerCase()}
                          </Badge>
                          <span
                            className="text-sm font-mono text-muted-foreground truncate max-w-[250px]"
                            title={event.deviceId}
                          >
                            {event.deviceId}
                          </span>
                          <PlatformIcon
                            platform={event.platform}
                            className="h-4 w-4 text-muted-foreground"
                          />
                        </div>

                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1.5">
                            <span className="opacity-70">Bundle:</span>
                            <BundleIdDisplay bundleId={event.bundleId} />
                          </div>
                          {event.appVersion && (
                            <div className="flex items-center gap-1.5 border-l pl-3 border-border/50">
                              <span className="opacity-70">App v:</span>
                              <span className="font-mono">
                                {event.appVersion}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex sm:flex-col items-center sm:items-end gap-2 sm:gap-1 text-right ml-auto pl-4">
                        <ChannelBadge channel={event.channel} />
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
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

                <div className="flex items-center justify-between px-4 py-3 border-t">
                  <div className="text-xs text-muted-foreground font-medium">
                    Showing{" "}
                    <span className="text-foreground">{currentOffset + 1}</span>{" "}
                    to{" "}
                    <span className="text-foreground">
                      {Math.min(currentOffset + events.length, totalEvents)}
                    </span>{" "}
                    of <span className="text-foreground">{totalEvents}</span>{" "}
                    entries
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePreviousPage}
                      disabled={!hasPreviousPage}
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleNextPage}
                      disabled={!hasNextPage}
                    >
                      Next
                      <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <AppVersionDetailSheet
        selectedVersion={selectedVersion}
        onOpenChange={(open) => !open && setSelectedVersion(null)}
        analyticsEvents={analyticsEvents}
      />

      <BundleDetailSheet
        selectedBundle={selectedBundleId}
        onOpenChange={(open) => !open && setSelectedBundleId(null)}
        analyticsEvents={analyticsEvents}
      />
    </div>
  );
}
