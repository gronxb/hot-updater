import { createFileRoute, Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  ArrowLeft,
  ArrowUpRight,
  ExternalLink,
  RotateCcw,
  Search,
  User,
} from "lucide-react";
import { useMemo, useState } from "react";
import { AnalyticsShell } from "@/components/features/analytics/AnalyticsShell";
import {
  DataGrid,
  type DataGridColumn,
} from "@/components/features/analytics/DataGrid";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { DeviceEvent } from "@/lib/analytics-utils";
import { useDeviceEventsQuery } from "@/lib/api";
import { ANALYTICS_EVENTS_LIMIT } from "@/lib/constants";
import { getEventTypeVariant } from "@/lib/status-utils";

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
  const [showRecoveredOnly, setShowRecoveredOnly] = useState(false);

  const { data: analyticsData, isLoading } = useDeviceEventsQuery({
    limit: ANALYTICS_EVENTS_LIMIT,
    offset: 0,
  });

  const analyticsEvents: DeviceEvent[] = analyticsData?.data ?? [];

  const allDeviceData = useMemo(() => {
    const devices: Record<string, DeviceData> = {};
    for (const event of analyticsEvents) {
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
  }, [analyticsEvents]);

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

  const columns: Array<DataGridColumn<DeviceData>> = [
    {
      key: "device",
      header: "Device ID",
      render: (device) => (
        <span className="font-mono text-[0.68rem] block max-w-[240px] truncate">
          {device.deviceId}
        </span>
      ),
    },
    {
      key: "promoted",
      header: "Promoted",
      headerClassName: "text-right",
      cellClassName: "text-right text-success",
      render: (device) => device.promoted.toLocaleString(),
    },
    {
      key: "recovered",
      header: "Recovered",
      headerClassName: "text-right",
      cellClassName: "text-right text-[color:var(--event-recovered)]",
      render: (device) => device.recovered.toLocaleString(),
    },
    {
      key: "total",
      header: "Total",
      headerClassName: "text-right",
      cellClassName: "text-right",
      render: (device) => (
        <span className="font-semibold">{device.total.toLocaleString()}</span>
      ),
    },
    {
      key: "lastSeen",
      header: "Last Seen",
      headerClassName: "text-right",
      cellClassName: "text-right text-muted-foreground text-[0.7rem]",
      render: (device) =>
        device.lastSeen ? dayjs(device.lastSeen).fromNow() : "-",
    },
  ];

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  return (
    <AnalyticsShell
      title="Device Activity"
      breadcrumbs={
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link
                  to="/analytics"
                  search={{
                    bundleId: undefined,
                    platform: undefined,
                    channel: undefined,
                    offset: undefined,
                  }}
                >
                  Analytics
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Device Activity</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      }
      controls={
        <Link
          to="/analytics"
          search={{
            bundleId: undefined,
            platform: undefined,
            channel: undefined,
            offset: undefined,
          }}
        >
          <Button variant="quiet" size="sm" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Overview
          </Button>
        </Link>
      }
    >
      <Card variant="editorial">
        <CardHeader className="flex flex-col gap-4 p-5 pb-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-sm font-semibold">
              Device Event Ledger
            </CardTitle>
            <CardDescription className="text-xs">
              Per-device event totals and most recent activity
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-[220px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search device ID..."
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="recoveredOnly"
                checked={showRecoveredOnly}
                onCheckedChange={setShowRecoveredOnly}
              />
              <Label
                htmlFor="recoveredOnly"
                className="text-xs whitespace-nowrap"
              >
                Recoveries only
              </Label>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-5 pt-4">
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <DataGrid
              data={paginatedData}
              columns={columns}
              getRowKey={(row) => row.deviceId}
              onRowClick={(row) => setSelectedDevice(row.deviceId)}
              empty={
                <div className="rounded-xl border border-[var(--panel-border)] bg-[var(--panel-surface)] p-10 text-center">
                  <p className="text-sm text-muted-foreground">
                    {search
                      ? "No matching devices found."
                      : "No device data collected yet."}
                  </p>
                </div>
              }
            />
          )}

          {totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-muted-foreground tabular-nums">
                Page {page + 1} of {totalPages} ({filteredData.length} devices)
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
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
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

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

          {selectedDeviceData ? (
            <div className="p-6 space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <Card variant="editorial">
                  <CardContent className="p-4 text-center">
                    <p className="text-2xl font-bold text-success tabular-nums">
                      {selectedDeviceData.promoted.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Promoted
                    </p>
                  </CardContent>
                </Card>
                <Card variant="editorial">
                  <CardContent className="p-4 text-center">
                    <p className="text-2xl font-bold text-[color:var(--event-recovered)] tabular-nums">
                      {selectedDeviceData.recovered.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Recovered
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card variant="editorial">
                <CardContent className="p-4 space-y-3">
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
                    <span className="text-muted-foreground">
                      App Version(s)
                    </span>
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
                      {selectedDeviceData.appVersions.size > 3 ? (
                        <Badge variant="outline" className="text-xs">
                          +{selectedDeviceData.appVersions.size - 3}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Last Seen</span>
                    <span className="text-xs tabular-nums">
                      {selectedDeviceData.lastSeen
                        ? dayjs(selectedDeviceData.lastSeen).format(
                            "MMM D, YYYY h:mm A",
                          )
                        : "-"}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <div>
                <h4 className="text-sm font-medium mb-3">Event History</h4>
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {selectedDeviceEvents.map((event, i) => (
                    <div
                      key={event.id || i}
                      className="flex items-start gap-3 text-sm p-3 rounded-lg border border-[var(--panel-border)] bg-[var(--raised-surface)]/50 hover:bg-[var(--raised-surface)]"
                    >
                      <div
                        className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 ${
                          event.eventType === "PROMOTED"
                            ? "bg-success-muted text-success"
                            : "bg-event-recovered-muted text-[color:var(--event-recovered)]"
                        }`}
                      >
                        {event.eventType === "PROMOTED" ? (
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center justify-between">
                          <Badge variant={getEventTypeVariant(event.eventType)}>
                            {event.eventType.toLowerCase()}
                          </Badge>
                          <span className="text-[0.68rem] text-muted-foreground tabular-nums">
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
                        <div className="flex items-center gap-2 text-[0.68rem] text-muted-foreground">
                          <span>{event.platform}</span>
                          {event.appVersion ? (
                            <>
                              <span>·</span>
                              <span>v{event.appVersion}</span>
                            </>
                          ) : null}
                          <span>·</span>
                          <span>{event.channel}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </AnalyticsShell>
  );
}
