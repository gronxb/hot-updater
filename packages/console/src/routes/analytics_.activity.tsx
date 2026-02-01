import { createFileRoute, Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Monitor,
  RotateCcw,
  Search,
  User,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import type { DeviceEvent } from "@/lib/analytics-utils";
import { useDeviceEventsQuery } from "@/lib/api";
import { ANALYTICS_EVENTS_LIMIT } from "@/lib/constants";

dayjs.extend(relativeTime);

const PAGE_SIZE = 15;

type DeviceData = {
  deviceId: string;
  promoted: number;
  recovered: number;
  total: number;
  lastSeen: string | null;
  platforms: Set<string>;
  appVersions: Set<string>;
};

export const Route = createFileRoute("/analytics_/activity")({
  component: ActivityPage,
});

function ActivityPage() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState<
    "all" | "RECOVERED" | "PROMOTED"
  >("all");
  const [showRecoveredOnly, setShowRecoveredOnly] = useState(false);

  const { data: analyticsData, isLoading } = useDeviceEventsQuery({
    limit: ANALYTICS_EVENTS_LIMIT,
    offset: 0,
  });

  const analyticsEvents: DeviceEvent[] = analyticsData?.data ?? [];

  const filteredEvents = useMemo(() => {
    if (eventFilter === "all") return analyticsEvents;
    return analyticsEvents.filter((e) => e.eventType === eventFilter);
  }, [analyticsEvents, eventFilter]);

  const allDeviceData = useMemo(() => {
    const devices: Record<string, DeviceData> = {};
    for (const event of filteredEvents) {
      const dId = event.deviceId;
      if (!devices[dId]) {
        devices[dId] = {
          deviceId: dId,
          promoted: 0,
          recovered: 0,
          total: 0,
          lastSeen: null,
          platforms: new Set(),
          appVersions: new Set(),
        };
      }
      if (event.eventType === "PROMOTED") {
        devices[dId].promoted += 1;
      } else {
        devices[dId].recovered += 1;
      }
      devices[dId].total += 1;
      devices[dId].platforms.add(event.platform);
      if (event.appVersion) {
        devices[dId].appVersions.add(event.appVersion);
      }
      if (
        event.createdAt &&
        (!devices[dId].lastSeen || event.createdAt > devices[dId].lastSeen!)
      ) {
        devices[dId].lastSeen = event.createdAt;
      }
    }

    return Object.values(devices).sort((a, b) => {
      if (a.lastSeen && b.lastSeen) {
        return b.lastSeen.localeCompare(a.lastSeen);
      }
      return b.total - a.total;
    });
  }, [filteredEvents]);

  const filteredData = useMemo(() => {
    let data = allDeviceData;
    if (showRecoveredOnly) {
      data = data.filter((d) => d.recovered > 0);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      data = data.filter((d) => d.deviceId.toLowerCase().includes(q));
    }
    return data;
  }, [allDeviceData, search, showRecoveredOnly]);

  const totalPages = Math.ceil(filteredData.length / PAGE_SIZE);
  const paginatedData = filteredData.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  );

  const selectedDeviceData = useMemo(() => {
    if (!selectedDevice) return null;
    return allDeviceData.find((d) => d.deviceId === selectedDevice);
  }, [allDeviceData, selectedDevice]);

  const selectedDeviceEvents = useMemo(() => {
    if (!selectedDevice) return [];
    return analyticsEvents
      .filter((e) => e.deviceId === selectedDevice)
      .sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          return b.createdAt.localeCompare(a.createdAt);
        }
        return 0;
      });
  }, [analyticsEvents, selectedDevice]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  return (
    <div className="flex flex-col h-full bg-background min-h-screen">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <SidebarTrigger className="-ml-1" />
        <Link
          to="/analytics"
          search={{
            bundleId: undefined,
            platform: undefined,
            channel: undefined,
            offset: undefined,
          }}
        >
          <Button variant="ghost" size="sm" className="gap-1">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
        <div className="flex items-center gap-2 ml-2">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Device Activity</h1>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <Card className="bg-card/50 border-border/50">
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              All Devices
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Click on a row to see device event history
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search device ID..."
                  value={search}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select
                value={eventFilter}
                onValueChange={(v) =>
                  setEventFilter(v as "all" | "RECOVERED" | "PROMOTED")
                }
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Event type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Events</SelectItem>
                  <SelectItem value="RECOVERED">RECOVERED Only</SelectItem>
                  <SelectItem value="PROMOTED">PROMOTED Only</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="recoveredOnly"
                  checked={showRecoveredOnly}
                  onChange={(e) => setShowRecoveredOnly(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label
                  htmlFor="recoveredOnly"
                  className="text-sm whitespace-nowrap"
                >
                  Devices with recoveries only
                </Label>
              </div>
            </div>

            {isLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : filteredData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[300px] text-center">
                <User className="h-12 w-12 mb-4 opacity-20 text-muted-foreground" />
                <h3 className="text-lg font-medium text-foreground">
                  {search ? "No matching devices" : "No device data"}
                </h3>
                <p className="text-sm text-muted-foreground max-w-[400px] mt-2">
                  {search ? "Try a different search term." : "No events found."}
                </p>
              </div>
            ) : (
              <>
                <div className="rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/50">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium">
                          Device ID
                        </th>
                        <th className="px-4 py-3 text-right font-medium">
                          Promoted
                        </th>
                        <th className="px-4 py-3 text-right font-medium">
                          Recovered
                        </th>
                        <th className="px-4 py-3 text-right font-medium">
                          Total
                        </th>
                        <th className="px-4 py-3 text-right font-medium">
                          Last Seen
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {paginatedData.map((device) => (
                        <tr
                          key={device.deviceId}
                          className={`hover:bg-muted/30 cursor-pointer transition-colors ${device.recovered > device.promoted ? "bg-amber-500/5" : ""}`}
                          onClick={() => setSelectedDevice(device.deviceId)}
                        >
                          <td className="px-4 py-3 font-mono text-xs truncate max-w-[200px]">
                            {device.deviceId}
                          </td>
                          <td className="px-4 py-3 text-right text-emerald-600 dark:text-emerald-400">
                            {device.promoted.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right text-orange-600 dark:text-orange-400">
                            {device.recovered.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right font-medium">
                            {device.total.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right text-muted-foreground text-xs">
                            {device.lastSeen
                              ? dayjs(device.lastSeen).fromNow()
                              : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      Page {page + 1} of {totalPages} ({filteredData.length}{" "}
                      devices)
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        disabled={page === 0}
                      >
                        <ChevronLeft className="h-4 w-4 mr-1" />
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setPage((p) => Math.min(totalPages - 1, p + 1))
                        }
                        disabled={page >= totalPages - 1}
                      >
                        Next
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Sheet
        open={!!selectedDevice}
        onOpenChange={(open) => !open && setSelectedDevice(null)}
      >
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <User className="h-4 w-4" />
              Device Details
            </SheetTitle>
            <SheetDescription className="font-mono text-xs truncate">
              {selectedDevice}
            </SheetDescription>
          </SheetHeader>

          {selectedDeviceData && (
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                    {selectedDeviceData.promoted.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Promoted</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold text-orange-600 dark:text-orange-400">
                    {selectedDeviceData.recovered.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Recovered
                  </p>
                </div>
              </div>

              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Platform(s)</span>
                  <div className="flex gap-1">
                    {Array.from(selectedDeviceData.platforms).map((p) => (
                      <Badge key={p} variant="secondary" className="text-xs">
                        {p}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">App Version(s)</span>
                  <div className="flex gap-1 flex-wrap justify-end max-w-[150px]">
                    {Array.from(selectedDeviceData.appVersions)
                      .slice(0, 3)
                      .map((v) => (
                        <Badge
                          key={v}
                          variant="outline"
                          className="text-xs font-mono"
                        >
                          {v}
                        </Badge>
                      ))}
                    {selectedDeviceData.appVersions.size > 3 && (
                      <Badge variant="outline" className="text-xs">
                        +{selectedDeviceData.appVersions.size - 3}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Last Seen</span>
                  <span className="text-xs">
                    {selectedDeviceData.lastSeen
                      ? dayjs(selectedDeviceData.lastSeen).format(
                          "MMM D, YYYY h:mm A",
                        )
                      : "-"}
                  </span>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-medium mb-3">Event History</h4>
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {selectedDeviceEvents.map((event, i) => (
                    <div
                      key={event.id || i}
                      className="flex items-start gap-3 text-sm p-3 rounded-md border hover:bg-muted/50"
                    >
                      <div
                        className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${
                          event.eventType === "PROMOTED"
                            ? "bg-emerald-500/10 text-emerald-500"
                            : "bg-orange-500/10 text-orange-500"
                        }`}
                      >
                        {event.eventType === "PROMOTED" ? (
                          <ArrowUpRight className="h-4 w-4" />
                        ) : (
                          <RotateCcw className="h-4 w-4" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center justify-between">
                          <Badge
                            variant="outline"
                            className={
                              event.eventType === "PROMOTED"
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                                : "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20"
                            }
                          >
                            {event.eventType.toLowerCase()}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {event.createdAt
                              ? dayjs(event.createdAt).fromNow()
                              : "Unknown"}
                          </span>
                        </div>
                        <Link
                          to="/"
                          search={{
                            bundleId: event.bundleId,
                            channel: undefined,
                            platform: undefined,
                            offset: undefined,
                          }}
                          className="font-mono text-xs text-primary hover:underline flex items-center gap-1"
                        >
                          Bundle: {event.bundleId}
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </Link>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{event.platform}</span>
                          {event.appVersion && (
                            <>
                              <span>•</span>
                              <span>v{event.appVersion}</span>
                            </>
                          )}
                          <span>•</span>
                          <span>{event.channel}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
