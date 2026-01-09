import { createFileRoute } from "@tanstack/react-router";
import { useDeviceEventsQuery, useRolloutStatsQuery } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { PlatformIcon } from "@/components/PlatformIcon";
import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  RotateCcw,
  Radio,
} from "lucide-react";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      bundleId: search.bundleId as string | undefined,
      platform: search.platform as "ios" | "android" | undefined,
      channel: search.channel as string | undefined,
    };
  },
});

function AnalyticsPage() {
  const { bundleId, platform, channel } = Route.useSearch();

  const { data: eventsData, isLoading: isLoadingEvents } = useDeviceEventsQuery(
    {
      bundleId,
      platform,
      channel,
      limit: 50,
    },
  );

  const { data: rolloutStats, isLoading: isLoadingStats } =
    useRolloutStatsQuery(bundleId ?? "");

  const events = eventsData?.data ?? [];
  const totalEvents = eventsData?.pagination.total ?? 0;

  const stats =
    bundleId && rolloutStats
      ? {
          total: rolloutStats.totalDevices,
          promoted: rolloutStats.promotedCount,
          recovered: rolloutStats.recoveredCount,
          successRate: rolloutStats.successRate,
        }
      : {
          total: totalEvents,
          promoted: events.filter((e: { eventType: string }) => e.eventType === "PROMOTED").length,
          recovered: events.filter((e: { eventType: string }) => e.eventType === "RECOVERED").length,
          successRate: null,
        };

  return (
    <div className="flex flex-col h-full bg-background min-h-screen">
      <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="text-lg font-semibold">Analytics</h1>
        {bundleId && (
          <>
            <Separator orientation="vertical" className="mx-2 h-4" />
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Bundle:</span>
              <BundleIdDisplay bundleId={bundleId} />
            </div>
          </>
        )}
      </header>

      <div className="flex-1 overflow-auto p-6 space-y-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="bg-card/50 hover:bg-card/80 transition-colors border-border/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Total Events
              </CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoadingEvents ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <div className="text-2xl font-bold">
                  {stats.total.toLocaleString()}
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Recorded device interactions
              </p>
            </CardContent>
          </Card>

          <Card className="bg-card/50 hover:bg-card/80 transition-colors border-border/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Promoted</CardTitle>
              <ArrowUpRight className="h-4 w-4 text-emerald-500" />
            </CardHeader>
            <CardContent>
              {isLoadingStats && bundleId ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <div className="text-2xl font-bold text-emerald-500">
                  {stats.promoted.toLocaleString()}
                  {!bundleId && (
                    <span className="text-xs text-muted-foreground ml-1 font-normal">
                      (visible)
                    </span>
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Successful updates
              </p>
            </CardContent>
          </Card>

          <Card className="bg-card/50 hover:bg-card/80 transition-colors border-border/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Recovered</CardTitle>
              <RotateCcw className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              {isLoadingStats && bundleId ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <div className="text-2xl font-bold text-orange-500">
                  {stats.recovered.toLocaleString()}
                  {!bundleId && (
                    <span className="text-xs text-muted-foreground ml-1 font-normal">
                      (visible)
                    </span>
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Rolled back updates
              </p>
            </CardContent>
          </Card>

          <Card className="bg-card/50 hover:bg-card/80 transition-colors border-border/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Success Rate
              </CardTitle>
              <CheckCircle2 className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              {isLoadingStats && bundleId ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <div className="text-2xl font-bold text-blue-500">
                  {stats.successRate !== null ? `${stats.successRate}%` : "--"}
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Overall stability score
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight">
              Recent Activity
            </h2>
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
                          className="text-sm font-mono text-muted-foreground truncate max-w-[150px]"
                          title={event.deviceId}
                        >
                          {event.deviceId.slice(0, 8)}...
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
                          ? dayjs(event.createdAt).fromNow()
                          : "Unknown time"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
