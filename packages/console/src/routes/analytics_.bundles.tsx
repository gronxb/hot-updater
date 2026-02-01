import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Package,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import { BundleDetailSheet } from "@/components/features/analytics/BundleDetailSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import type { DeviceEvent } from "@/lib/analytics-utils";
import { useDeviceEventsQuery } from "@/lib/api";
import { ANALYTICS_EVENTS_LIMIT } from "@/lib/constants";

const PAGE_SIZE = 10;

type BundleData = {
  bundleId: string;
  promoted: number;
  recovered: number;
  total: number;
  successRate: number;
};

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
    const counts: Record<string, BundleData> = {};
    for (const event of analyticsEvents) {
      const bId = event.bundleId;
      if (!counts[bId]) {
        counts[bId] = {
          bundleId: bId,
          promoted: 0,
          recovered: 0,
          total: 0,
          successRate: 0,
        };
      }
      if (event.eventType === "PROMOTED") {
        counts[bId].promoted += 1;
      } else {
        counts[bId].recovered += 1;
      }
      counts[bId].total += 1;
    }

    return Object.values(counts)
      .map((b) => ({
        ...b,
        successRate: b.total > 0 ? (b.promoted / b.total) * 100 : 0,
      }))
      .sort((a, b) => b.total - a.total);
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
    <div className="flex flex-col h-full bg-background min-h-screen">
      <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4" />
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
        <Separator orientation="vertical" className="mx-2 h-4" />
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Bundles</h1>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <Card className="bg-card/50 border-border/50">
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              All Bundles
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Click on a row to see detailed breakdown
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search bundle ID..."
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>

            {isLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : filteredData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[300px] text-center">
                <Package className="h-12 w-12 mb-4 opacity-20 text-muted-foreground" />
                <h3 className="text-lg font-medium text-foreground">
                  {search ? "No matching bundles" : "No bundle data"}
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
                          Bundle ID
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
                          Success Rate
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {paginatedData.map((bundle) => (
                        <tr
                          key={bundle.bundleId}
                          className="hover:bg-muted/30 cursor-pointer transition-colors"
                          onClick={() => setSelectedBundle(bundle.bundleId)}
                        >
                          <td className="px-4 py-3 font-mono text-xs">
                            {bundle.bundleId}
                          </td>
                          <td className="px-4 py-3 text-right text-emerald-600 dark:text-emerald-400">
                            {bundle.promoted.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right text-orange-600 dark:text-orange-400">
                            {bundle.recovered.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right font-medium">
                            {bundle.total.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Badge
                              variant="outline"
                              className={
                                bundle.successRate >= 90
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                                  : bundle.successRate >= 70
                                    ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20"
                                    : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
                              }
                            >
                              {bundle.successRate.toFixed(1)}%
                            </Badge>
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
                      bundles)
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

      <BundleDetailSheet
        selectedBundle={selectedBundle}
        onOpenChange={handleSheetClose}
        analyticsEvents={analyticsEvents}
      />
    </div>
  );
}
