import type { Bundle } from "@hot-updater/plugin-core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BundleEditorSheet } from "@/components/features/bundles/BundleEditorSheet";
import { BundlesTable } from "@/components/features/bundles/BundlesTable";
import { FilterToolbar } from "@/components/features/bundles/FilterToolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { useFilterParams } from "@/hooks/useFilterParams";
import { useBundleQuery, useBundlesQuery } from "@/lib/api";

export const Route = createFileRoute("/")({
  component: BundlesPage,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      channel: search.channel as string | undefined,
      platform: search.platform as "ios" | "android" | undefined,
      offset: search.offset as string | undefined,
      bundleId: search.bundleId as string | undefined,
    };
  },
});

function BundlesPage() {
  const { filters } = useFilterParams();
  const { bundleId } = Route.useSearch();
  const navigate = useNavigate();
  const [selectedBundle, setSelectedBundle] = useState<Bundle | null>(null);

  const { data: bundleFromUrl } = useBundleQuery(bundleId ?? "");

  useEffect(() => {
    if (bundleFromUrl && bundleId) {
      setSelectedBundle(bundleFromUrl);
    }
  }, [bundleFromUrl, bundleId]);

  const handleSheetClose = () => {
    setSelectedBundle(null);
    if (bundleId) {
      void navigate({
        to: "/",
        search: {
          channel: filters.channel,
          platform: filters.platform,
          offset: filters.offset,
          bundleId: undefined,
        },
      });
    }
  };

  const { data: bundlesData, isLoading } = useBundlesQuery({
    channel: filters.channel,
    platform: filters.platform,
    offset: filters.offset,
    limit: "20",
  });

  const bundles = bundlesData?.data ?? [];

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <FilterToolbar />
        <div className="flex-1 p-[var(--spacing-section)] space-y-[var(--spacing-component)] bg-muted/5">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <FilterToolbar />
      <div className="flex-1 p-[var(--spacing-section)] space-y-[var(--spacing-section)] bg-muted/5">
        <BundlesTable
          bundles={bundles}
          onRowClick={(bundle) => setSelectedBundle(bundle)}
        />
      </div>

      <BundleEditorSheet
        bundle={selectedBundle}
        open={!!selectedBundle}
        onOpenChange={(open) => !open && handleSheetClose()}
      />
    </div>
  );
}
