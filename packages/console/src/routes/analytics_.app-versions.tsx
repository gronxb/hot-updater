import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { AppVersionDetailSheet } from "@/components/features/analytics/AppVersionDetailSheet";
import { AnalyticsSection } from "@/components/features/analytics/AnalyticsSection";
import { AnalyticsShell } from "@/components/features/analytics/AnalyticsShell";
import {
  type DataGridColumn,
  DataGrid,
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
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { aggregateByAppVersion, type AppVersionData, type DeviceEvent } from "@/lib/analytics-utils";
import { useDeviceEventsQuery } from "@/lib/api";
import { ANALYTICS_EVENTS_LIMIT } from "@/lib/constants";
import { getSuccessRateVariant } from "@/lib/status-utils";

const PAGE_SIZE = 10;

export const Route = createFileRoute("/analytics_/app-versions")({
  component: AppVersionsPage,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      version: search.version as string | undefined,
    };
  },
});

function AppVersionsPage() {
  const { version: versionParam } = Route.useSearch();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(
    versionParam ?? null,
  );

  const { data: analyticsData, isLoading } = useDeviceEventsQuery({
    limit: ANALYTICS_EVENTS_LIMIT,
    offset: 0,
  });

  const analyticsEvents: DeviceEvent[] = analyticsData?.data ?? [];

  const allAppVersionData = useMemo(() => {
    return aggregateByAppVersion(analyticsEvents);
  }, [analyticsEvents]);

  const filteredData = useMemo(() => {
    if (!search.trim()) return allAppVersionData;
    const q = search.toLowerCase();
    return allAppVersionData.filter((v) =>
      v.appVersion.toLowerCase().includes(q),
    );
  }, [allAppVersionData, search]);

  const totalPages = Math.ceil(filteredData.length / PAGE_SIZE);
  const paginatedData = filteredData.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  );

  const columns: Array<DataGridColumn<AppVersionData>> = [
    {
      key: "version",
      header: "Version",
      render: (version) => (
        <span className="font-mono text-xs">{version.appVersion}</span>
      ),
    },
    {
      key: "promoted",
      header: "Promoted",
      headerClassName: "text-right",
      cellClassName: "text-right text-success",
      render: (version) => version.promoted.toLocaleString(),
    },
    {
      key: "recovered",
      header: "Recovered",
      headerClassName: "text-right",
      cellClassName: "text-right text-[color:var(--event-recovered)]",
      render: (version) => version.recovered.toLocaleString(),
    },
    {
      key: "total",
      header: "Total",
      headerClassName: "text-right",
      cellClassName: "text-right",
      render: (version) => <span className="font-semibold">{version.total.toLocaleString()}</span>,
    },
    {
      key: "success",
      header: "Success Rate",
      headerClassName: "text-right",
      cellClassName: "text-right",
      render: (version) => (
        <Badge variant={getSuccessRateVariant(version.successRate)}>
          {version.successRate.toFixed(1)}%
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
      setSelectedVersion(null);
      if (versionParam) {
        void navigate({
          to: "/analytics/app-versions",
          search: { version: undefined },
        });
      }
    }
  };

  return (
    <AnalyticsShell
      title="App Versions"
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
              <BreadcrumbPage>App Versions</BreadcrumbPage>
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
      <AnalyticsSection
        title="Version Matrix"
        description="Detected app versions with rollout and recovery metrics."
        action={
          <div className="flex items-center gap-2">
            <div className="relative w-[220px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search version..."
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        }
      >
        <Card variant="editorial" className="p-3 md:p-4">
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
              getRowKey={(row) => row.appVersion}
              onRowClick={(row) => setSelectedVersion(row.appVersion)}
              empty={
                <div className="rounded-xl border border-[var(--panel-border)] bg-[var(--panel-surface)] p-10 text-center">
                  <p className="text-sm text-muted-foreground">
                    {search ? "No matching versions found." : "No version data collected yet."}
                  </p>
                </div>
              }
            />
          )}

          {totalPages > 1 ? (
            <div className="mt-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Page {page + 1} of {totalPages} ({filteredData.length} versions)
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="panel"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <Button
                  variant="panel"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      </AnalyticsSection>

      <AppVersionDetailSheet
        selectedVersion={selectedVersion}
        onOpenChange={handleSheetClose}
        analyticsEvents={analyticsEvents}
      />
    </AnalyticsShell>
  );
}
