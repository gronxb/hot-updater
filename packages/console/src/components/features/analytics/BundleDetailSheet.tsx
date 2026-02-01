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
import type { DeviceEvent } from "@/lib/analytics-utils";

dayjs.extend(relativeTime);

type BundleData = {
  bundleId: string;
  promoted: number;
  recovered: number;
  total: number;
  successRate: number;
};

type BundleDetailSheetProps = {
  selectedBundle: string | null;
  onOpenChange: (open: boolean) => void;
  analyticsEvents: DeviceEvent[];
};

export function BundleDetailSheet({
  selectedBundle,
  onOpenChange,
  analyticsEvents,
}: BundleDetailSheetProps) {
  const selectedBundleData = useMemo(() => {
    if (!selectedBundle) return null;
    const counts: BundleData = {
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
  }, [analyticsEvents, selectedBundle]);

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
      <SheetContent className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
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
            <Button variant="outline" size="sm" className="w-full mt-2 gap-2">
              <Edit className="h-4 w-4" />
              Edit Bundle
            </Button>
          </Link>
        </SheetHeader>

        {selectedBundleData && (
          <div className="p-6 space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border p-4 text-center">
                <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                  {selectedBundleData.promoted.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Promoted</p>
              </div>
              <div className="rounded-lg border p-4 text-center">
                <p className="text-2xl font-bold text-orange-600 dark:text-orange-400">
                  {selectedBundleData.recovered.toLocaleString()}
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
                    selectedBundleData.successRate >= 90
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                      : selectedBundleData.successRate >= 70
                        ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20"
                        : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
                  }
                >
                  {selectedBundleData.successRate.toFixed(1)}%
                </Badge>
              </div>
              <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all"
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
                      className="flex items-center justify-between text-sm p-2 rounded-md hover:bg-muted/50"
                    >
                      <span className="font-mono text-xs">
                        {ver.appVersion}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {ver.promoted}
                        </span>
                        <span className="text-muted-foreground">/</span>
                        <span className="text-orange-600 dark:text-orange-400">
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
              <div className="space-y-2 max-h-[260px] border rounded-md p-2 overflow-y-auto">
                {selectedBundleEvents.slice(0, 10).map((event, i) => (
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
