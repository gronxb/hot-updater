import { Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { ArrowUpRight, Edit, Package, RotateCcw } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { BundleData, DeviceEvent } from "@/lib/analytics-utils";
import { getSuccessRateVariant } from "@/lib/status-utils";

dayjs.extend(relativeTime);

type BundleDetailSheetProps = {
  selectedBundle: string | null;
  onOpenChange: (open: boolean) => void;
  analyticsEvents: DeviceEvent[];
  // Optional pre-aggregated data for performance
  bundleMap?: Map<string, BundleData>;
};

export function BundleDetailSheet({
  selectedBundle,
  onOpenChange,
  analyticsEvents,
  bundleMap,
}: BundleDetailSheetProps) {
  const selectedBundleData = useMemo(() => {
    if (!selectedBundle) return null;
    // Use pre-aggregated data if available for O(1) lookup
    if (bundleMap) {
      return bundleMap.get(selectedBundle) || null;
    }
    // Fallback to computing (for backward compatibility)
    const counts = {
      bundleId: selectedBundle,
      promoted: 0,
      recovered: 0,
      total: 0,
      successRate: 0,
    };
    for (const event of analyticsEvents) {
      if (event.bundleId === selectedBundle) {
        if (event.eventType === "PROMOTED") {
          counts.promoted += 1;
        } else {
          counts.recovered += 1;
        }
        counts.total += 1;
      }
    }
    counts.successRate =
      counts.total > 0 ? (counts.promoted / counts.total) * 100 : 0;
    return counts.total > 0 ? counts : null;
  }, [analyticsEvents, selectedBundle, bundleMap]);

  const selectedBundleVersions = useMemo(() => {
    if (!selectedBundle) return [];
    const bundleEvents = analyticsEvents.filter(
      (e) => e.bundleId === selectedBundle,
    );
    const versionMap: Record<
      string,
      { appVersion: string; promoted: number; recovered: number; total: number }
    > = {};
    for (const event of bundleEvents) {
      const ver = event.appVersion || "Unknown";
      if (!versionMap[ver]) {
        versionMap[ver] = {
          appVersion: ver,
          promoted: 0,
          recovered: 0,
          total: 0,
        };
      }
      if (event.eventType === "PROMOTED") {
        versionMap[ver].promoted += 1;
      } else {
        versionMap[ver].recovered += 1;
      }
      versionMap[ver].total += 1;
    }
    return Object.values(versionMap).sort((a, b) => b.total - a.total);
  }, [analyticsEvents, selectedBundle]);

  const selectedBundleEvents = useMemo(() => {
    if (!selectedBundle) return [];
    return analyticsEvents.filter((e) => e.bundleId === selectedBundle);
  }, [analyticsEvents, selectedBundle]);

  return (
    <Sheet open={!!selectedBundle} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg overflow-y-auto bg-[var(--panel-surface)]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base">
            <Package className="h-4 w-4" />
            <span className="font-mono text-sm truncate">{selectedBundle}</span>
          </SheetTitle>
          <SheetDescription>
            Detailed breakdown for this bundle
          </SheetDescription>
          <Link
            to="/"
            search={{
              bundleId: selectedBundle ?? undefined,
              channel: undefined,
              platform: undefined,
              offset: undefined,
            }}
          >
            <Button variant="panel" size="sm" className="w-full mt-2 gap-2">
              <Edit className="h-4 w-4" />
              Edit Bundle
            </Button>
          </Link>
        </SheetHeader>

        {selectedBundleData && (
          <div className="p-6 space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--raised-surface)] p-4 text-center">
                <p className="text-2xl font-bold text-success">
                  {selectedBundleData.promoted.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Promoted</p>
              </div>
              <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--raised-surface)] p-4 text-center">
                <p className="text-2xl font-bold text-[color:var(--event-recovered)]">
                  {selectedBundleData.recovered.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Recovered</p>
              </div>
            </div>

            <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--raised-surface)] p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Success Rate</p>
                <Badge variant={getSuccessRateVariant(selectedBundleData.successRate)}>
                  {selectedBundleData.successRate.toFixed(1)}%
                </Badge>
              </div>
              <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-success transition-all"
                  style={{ width: `${selectedBundleData.successRate}%` }}
                />
              </div>
            </div>

            <div>
              <h4 className="text-sm font-medium mb-3">
                App Version Distribution
              </h4>
              {selectedBundleVersions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No version data</p>
              ) : (
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {selectedBundleVersions.slice(0, 10).map((ver) => (
                    <div
                      key={ver.appVersion}
                      className="flex items-center justify-between text-sm p-2 rounded-md bg-[var(--raised-surface)] hover:bg-[var(--raised-surface-hover)]"
                    >
                      <span className="font-mono text-xs">
                        {ver.appVersion}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-success">
                          {ver.promoted}
                        </span>
                        <span className="text-muted-foreground">/</span>
                        <span className="text-[color:var(--event-recovered)]">
                          {ver.recovered}
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
                {selectedBundleEvents.slice(0, 10).map((event, i) => (
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
