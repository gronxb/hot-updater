import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { AnalyticsShell } from "@/components/features/analytics/AnalyticsShell";
import { BundleDetailSheet } from "@/components/features/analytics/BundleDetailSheet";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  aggregateByBundle,
  type BundleData,
  type DeviceEvent,
} from "@/lib/analytics-utils";
import { useDeviceEventsQuery } from "@/lib/api";
import { ANALYTICS_EVENTS_LIMIT } from "@/lib/constants";
import { getSuccessRateVariant } from "@/lib/status-utils";

const PAGE_SIZE = 10;

export const Route = createFileRoute("/analytics_/bundles")({
  component: BundlesPage,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      bundle: search.bundle as string | undefined,
    };
  },
});

function BundlesPage() {
  const { bundle: bundleParam } = Route.useSearch();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedBundle, setSelectedBundle] = useState<string | null>(
    bundleParam ?? null,
  );

  const { data: analyticsData, isLoading } = useDeviceEventsQuery({
    limit: ANALYTICS_EVENTS_LIMIT,
    offset: 0,
  });

  const analyticsEvents: DeviceEvent[] = analyticsData?.data ?? [];

  const allBundleData = useMemo(() => {
    return aggregateByBundle(analyticsEvents);
  }, [analyticsEvents]);

  const filteredData = useMemo(() => {
    if (!search.trim()) return allBundleData;
    const q = search.toLowerCase();
    return allBundleData.filter((b) => b.bundleId.toLowerCase().includes(q));
  }, [allBundleData, search]);

  const totalPages = Math.ceil(filteredData.length / PAGE_SIZE);
  const paginatedData = filteredData.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  );

  const columns: Array<DataGridColumn<BundleData>> = [
    {
      key: "bundleId",
      header: "Bundle ID",
      render: (bundle) => (
        <span className="font-mono text-[0.68rem]">{bundle.bundleId}</span>
      ),
    },
    {
      key: "promoted",
      header: "Promoted",
      headerClassName: "text-right",
      cellClassName: "text-right text-success",
      render: (bundle) => bundle.promoted.toLocaleString(),
    },
    {
      key: "recovered",
      header: "Recovered",
      headerClassName: "text-right",
      cellClassName: "text-right text-[color:var(--event-recovered)]",
      render: (bundle) => bundle.recovered.toLocaleString(),
    },
    {
      key: "total",
      header: "Total",
      headerClassName: "text-right",
      cellClassName: "text-right",
      render: (bundle) => (
        <span className="font-semibold">{bundle.total.toLocaleString()}</span>
      ),
    },
    {
      key: "devices",
      header: "Devices",
      headerClassName: "text-right",
      cellClassName: "text-right text-muted-foreground",
      render: (bundle) => bundle.deviceCount.toLocaleString(),
    },
    {
      key: "success",
      header: "Success Rate",
      headerClassName: "text-right",
      cellClassName: "text-right",
      render: (bundle) => (
        <Badge variant={getSuccessRateVariant(bundle.successRate)}>
          {bundle.successRate.toFixed(1)}%
        </Badge>
      ),
    },
  ];

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  const handleSheetClose = (open: boolean) => {
    if (!open) {
      setSelectedBundle(null);
      if (bundleParam) {
        void navigate({
          to: "/analytics/bundles",
          search: { bundle: undefined },
        });
      }
    }
  };

  return (
    <AnalyticsShell
      title="Bundles"
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
              <BreadcrumbPage>Bundles</BreadcrumbPage>
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
              Bundle Reliability Ledger
            </CardTitle>
            <CardDescription className="text-xs">
              Bundle-level rollout stability, recovery trend, and device impact
            </CardDescription>
          </div>
          <div className="relative w-[220px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search bundle ID..."
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
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
              getRowKey={(row) => row.bundleId}
              onRowClick={(row) => setSelectedBundle(row.bundleId)}
              empty={
                <div className="rounded-xl border border-[var(--panel-border)] bg-[var(--panel-surface)] p-10 text-center">
                  <p className="text-sm text-muted-foreground">
                    {search
                      ? "No matching bundles found."
                      : "No bundle data collected yet."}
                  </p>
                </div>
              }
            />
          )}

          {totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-muted-foreground tabular-nums">
                Page {page + 1} of {totalPages} ({filteredData.length} bundles)
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

      <BundleDetailSheet
        selectedBundle={selectedBundle}
        onOpenChange={handleSheetClose}
        analyticsEvents={analyticsEvents}
      />
    </AnalyticsShell>
  );
}
