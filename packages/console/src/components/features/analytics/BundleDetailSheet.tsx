import { Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { Edit, Package } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <Card variant="outline">
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-semibold text-success tabular-nums">
                    {selectedBundleData.promoted.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Promoted</p>
                </CardContent>
              </Card>
              <Card variant="outline">
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-semibold text-[color:var(--event-recovered)] tabular-nums">
                    {selectedBundleData.recovered.toLocaleString()}
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
                      selectedBundleData.successRate,
                    )}
                  >
                    {selectedBundleData.successRate.toFixed(1)}%
                  </Badge>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-success transition-all"
                    style={{
                      width: `${selectedBundleData.successRate}%`,
                    }}
                  />
                </div>
              </CardContent>
            </Card>

            <div>
              <h4 className="text-sm font-medium mb-3">
                App Version Distribution
              </h4>
              {selectedBundleVersions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No version data</p>
              ) : (
                <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                  {selectedBundleVersions.slice(0, 10).map((ver) => (
                    <div
                      key={ver.appVersion}
                      className="flex items-center justify-between text-sm px-3 py-2 rounded-lg border border-transparent hover:bg-muted/50"
                    >
                      <span className="font-mono text-xs">
                        {ver.appVersion}
                      </span>
                      <div className="flex items-center gap-1.5 text-xs tabular-nums">
                        <span className="text-success">{ver.promoted}</span>
                        <span className="text-muted-foreground/50">/</span>
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
              <div className="space-y-1 max-h-[260px] overflow-y-auto">
                {selectedBundleEvents.slice(0, 10).map((event, i) => (
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
