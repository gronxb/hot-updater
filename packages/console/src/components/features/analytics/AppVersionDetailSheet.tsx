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
import { aggregateByAppVersion, type DeviceEvent } from "@/lib/analytics-utils";

dayjs.extend(relativeTime);

type AppVersionDetailSheetProps = {
  selectedVersion: string | null;
  onOpenChange: (open: boolean) => void;
  analyticsEvents: DeviceEvent[];
};

export function AppVersionDetailSheet({
  selectedVersion,
  onOpenChange,
  analyticsEvents,
}: AppVersionDetailSheetProps) {
  const selectedVersionData = useMemo(() => {
    if (!selectedVersion) return null;
    return aggregateByAppVersion(analyticsEvents).find(
      (v) => v.appVersion === selectedVersion,
    );
  }, [analyticsEvents, selectedVersion]);

  const selectedVersionBundles = useMemo(() => {
    if (!selectedVersion) return [];
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
  }, [analyticsEvents, selectedVersion]);

  const selectedVersionEvents = useMemo(() => {
    if (!selectedVersion) return [];
    return analyticsEvents.filter((e) => e.appVersion === selectedVersion);
  }, [analyticsEvents, selectedVersion]);

  return (
    <Sheet open={!!selectedVersion} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
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
              <div className="rounded-lg border p-4 text-center">
                <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                  {selectedVersionData.promoted.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Promoted</p>
              </div>
              <div className="rounded-lg border p-4 text-center">
                <p className="text-2xl font-bold text-orange-600 dark:text-orange-400">
                  {selectedVersionData.recovered.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Recovered</p>
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Success Rate</p>
                <Badge
                  variant="outline"
                  className={
                    selectedVersionData.successRate >= 90
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                      : selectedVersionData.successRate >= 70
                        ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20"
                        : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
                  }
                >
                  {selectedVersionData.successRate.toFixed(1)}%
                </Badge>
              </div>
              <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all"
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
                      className="flex items-center justify-between text-sm p-2 rounded-md hover:bg-muted/50"
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
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {bundle.promoted}
                        </span>
                        <span className="text-muted-foreground">/</span>
                        <span className="text-orange-600 dark:text-orange-400">
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
              <div className="space-y-2 max-h-[260px] border rounded-md p-2 overflow-y-auto">
                {selectedVersionEvents.slice(0, 10).map((event, i) => (
                  <div
                    key={event.id || i}
                    className="flex items-center gap-3 text-sm p-2 rounded-md hover:bg-muted/50"
                  >
                    <div
                      className={`h-6 w-6 rounded-full flex items-center justify-center ${
                        event.eventType === "PROMOTED"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : "bg-orange-500/10 text-orange-500"
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
