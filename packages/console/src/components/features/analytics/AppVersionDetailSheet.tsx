import { Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { ExternalLink, Smartphone } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  type AppVersionData,
  aggregateByAppVersion,
  type DeviceEvent,
} from "@/lib/analytics-utils";
import { getSuccessRateVariant } from "@/lib/status-utils";

dayjs.extend(relativeTime);

type AppVersionDetailSheetProps = {
  selectedVersion: string | null;
  onOpenChange: (open: boolean) => void;
  analyticsEvents: DeviceEvent[];
  // Optional pre-aggregated data for performance
  appVersionMap?: Map<string, AppVersionData>;
  versionBundlesMap?: Map<
    string,
    Array<{
      bundleId: string;
      promoted: number;
      recovered: number;
      total: number;
    }>
  >;
};

export function AppVersionDetailSheet({
  selectedVersion,
  onOpenChange,
  analyticsEvents,
  appVersionMap,
  versionBundlesMap,
}: AppVersionDetailSheetProps) {
  const selectedVersionData = useMemo(() => {
    if (!selectedVersion) return null;
    // Use pre-aggregated data if available for O(1) lookup
    if (appVersionMap) {
      return appVersionMap.get(selectedVersion) || null;
    }
    // Fallback to computing (for backward compatibility)
    return aggregateByAppVersion(analyticsEvents).find(
      (v) => v.appVersion === selectedVersion,
    );
  }, [analyticsEvents, selectedVersion, appVersionMap]);

  const selectedVersionBundles = useMemo(() => {
    if (!selectedVersion) return [];
    // Use pre-aggregated data if available for O(1) lookup
    if (versionBundlesMap) {
      return versionBundlesMap.get(selectedVersion) || [];
    }
    // Fallback to computing (for backward compatibility)
    const versionEvents = analyticsEvents.filter(
      (e) => e.appVersion === selectedVersion,
    );
    const bundleMap: Record<
      string,
      { bundleId: string; promoted: number; recovered: number; total: number }
    > = {};
    for (const event of versionEvents) {
      if (!bundleMap[event.bundleId]) {
        bundleMap[event.bundleId] = {
          bundleId: event.bundleId,
          promoted: 0,
          recovered: 0,
          total: 0,
        };
      }
      if (event.eventType === "PROMOTED") {
        bundleMap[event.bundleId].promoted += 1;
      } else {
        bundleMap[event.bundleId].recovered += 1;
      }
      bundleMap[event.bundleId].total += 1;
    }
    return Object.values(bundleMap).sort((a, b) => b.total - a.total);
  }, [analyticsEvents, selectedVersion, versionBundlesMap]);

  const selectedVersionEvents = useMemo(() => {
    if (!selectedVersion) return [];
    return analyticsEvents.filter((e) => e.appVersion === selectedVersion);
  }, [analyticsEvents, selectedVersion]);

  return (
    <Sheet open={!!selectedVersion} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg overflow-y-auto bg-[var(--panel-surface)]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base">
            <Smartphone className="h-4 w-4" />
            Version {selectedVersion}
          </SheetTitle>
          <SheetDescription>
            Detailed breakdown for this app version
          </SheetDescription>
        </SheetHeader>

        {selectedVersionData && (
          <div className="p-6 space-y-5 flex-1">
            <div className="grid grid-cols-2 gap-3">
              <Card variant="outline">
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-semibold text-success tabular-nums">
                    {selectedVersionData.promoted.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Promoted</p>
                </CardContent>
              </Card>
              <Card variant="outline">
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-semibold text-[color:var(--event-recovered)] tabular-nums">
                    {selectedVersionData.recovered.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Recovered
                  </p>
                </CardContent>
              </Card>
            </div>

            <Card variant="outline">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Success Rate</p>
                  <Badge
                    variant={getSuccessRateVariant(
                      selectedVersionData.successRate,
                    )}
                  >
                    {selectedVersionData.successRate.toFixed(1)}%
                  </Badge>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-success transition-all"
                    style={{
                      width: `${selectedVersionData.successRate}%`,
                    }}
                  />
                </div>
              </CardContent>
            </Card>

            <div>
              <h4 className="text-sm font-medium mb-3">Bundle Distribution</h4>
              {selectedVersionBundles.length === 0 ? (
                <p className="text-sm text-muted-foreground">No bundle data</p>
              ) : (
                <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                  {selectedVersionBundles.slice(0, 10).map((bundle) => (
                    <div
                      key={bundle.bundleId}
                      className="flex items-center justify-between text-sm px-3 py-2 rounded-lg border border-transparent hover:bg-muted/50"
                    >
                      <Link
                        to="/"
                        search={{
                          bundleId: bundle.bundleId,
                          channel: undefined,
                          platform: undefined,
                          offset: undefined,
                        }}
                        className="font-mono text-xs truncate max-w-[180px] text-primary hover:underline flex items-center gap-1"
                      >
                        {bundle.bundleId}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </Link>
                      <div className="flex items-center gap-1.5 text-xs tabular-nums">
                        <span className="text-success">{bundle.promoted}</span>
                        <span className="text-muted-foreground/50">/</span>
                        <span className="text-[color:var(--event-recovered)]">
                          {bundle.recovered}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h4 className="text-sm font-medium mb-3">Recent Events</h4>
              <div className="space-y-1 max-h-[260px] overflow-y-auto">
                {selectedVersionEvents.slice(0, 10).map((event, i) => (
                  <div
                    key={event.id || i}
                    className="flex items-center gap-3 text-sm px-3 py-2 rounded-lg hover:bg-muted/50"
                  >
                    <Badge
                      variant={
                        event.eventType === "PROMOTED" ? "success" : "warning"
                      }
                      className="text-[0.6rem] shrink-0"
                    >
                      {event.eventType === "PROMOTED" ? "P" : "R"}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-xs truncate">
                        {event.deviceId}
                      </p>
                      <p className="text-[0.68rem] text-muted-foreground">
                        {event.createdAt
                          ? dayjs(event.createdAt).fromNow()
                          : "Unknown"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
