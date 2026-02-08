import { Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  ArrowUpRight,
  ExternalLink,
  RotateCcw,
  Smartphone,
} from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  aggregateByAppVersion,
  type AppVersionData,
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
          <div className="p-6 space-y-6 flex-1">
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--raised-surface)] p-4 text-center">
                <p className="text-2xl font-bold text-success">
                  {selectedVersionData.promoted.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Promoted</p>
              </div>
              <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--raised-surface)] p-4 text-center">
                <p className="text-2xl font-bold text-[color:var(--event-recovered)]">
                  {selectedVersionData.recovered.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Recovered</p>
              </div>
            </div>

            <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--raised-surface)] p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Success Rate</p>
                <Badge variant={getSuccessRateVariant(selectedVersionData.successRate)}>
                  {selectedVersionData.successRate.toFixed(1)}%
                </Badge>
              </div>
              <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-success transition-all"
                  style={{ width: `${selectedVersionData.successRate}%` }}
                />
              </div>
            </div>

            <div>
              <h4 className="text-sm font-medium mb-3">Bundle Distribution</h4>
              {selectedVersionBundles.length === 0 ? (
                <p className="text-sm text-muted-foreground">No bundle data</p>
              ) : (
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {selectedVersionBundles.slice(0, 10).map((bundle) => (
                    <div
                      key={bundle.bundleId}
                      className="flex items-center justify-between text-sm p-2 rounded-md bg-[var(--raised-surface)] hover:bg-[var(--raised-surface-hover)]"
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
                      <div className="flex items-center gap-2">
                        <span className="text-success">
                          {bundle.promoted}
                        </span>
                        <span className="text-muted-foreground">/</span>
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
              <div className="space-y-2 max-h-[260px] border border-[var(--panel-border)] rounded-md p-2 overflow-y-auto bg-[var(--raised-surface)]/70">
                {selectedVersionEvents.slice(0, 10).map((event, i) => (
                  <div
                    key={event.id || i}
                    className="flex items-center gap-3 text-sm p-2 rounded-md hover:bg-[var(--raised-surface-hover)]"
                  >
                    <div
                      className={`h-6 w-6 rounded-full flex items-center justify-center ${
                        event.eventType === "PROMOTED"
                          ? "bg-success-muted text-success"
                          : "bg-event-recovered-muted text-[color:var(--event-recovered)]"
                      }`}
                    >
                      {event.eventType === "PROMOTED" ? (
                        <ArrowUpRight className="h-3 w-3" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-xs truncate">
                        {event.deviceId}
                      </p>
                      <p className="text-xs text-muted-foreground">
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
