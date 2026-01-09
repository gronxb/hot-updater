import { createFileRoute } from "@tanstack/react-router";
import { useBundlesQuery } from "@/lib/api";
import { FilterToolbar } from "@/components/features/bundles/FilterToolbar";
import { BundlesTable } from "@/components/features/bundles/BundlesTable";
import { BundleEditorSheet } from "@/components/features/bundles/BundleEditorSheet";
import { useFilterParams } from "@/hooks/useFilterParams";
import { useState } from "react";
import type { Bundle } from "@hot-updater/plugin-core";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/")({
  component: BundlesPage,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      channel: search.channel as string | undefined,
      platform: search.platform as "ios" | "android" | undefined,
      offset: search.offset as string | undefined,
    };
  },
});

function BundlesPage() {
  const { filters } = useFilterParams();
  const [selectedBundle, setSelectedBundle] = useState<Bundle | null>(null);

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
        <div className="flex-1 p-6 space-y-4 bg-muted/5">
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
      <div className="flex-1 p-6 space-y-6 bg-muted/5">
        <BundlesTable
          bundles={bundles}
          onRowClick={(bundle) => setSelectedBundle(bundle)}
        />
      </div>

      <BundleEditorSheet
        bundle={selectedBundle}
        open={!!selectedBundle}
        onOpenChange={(open) => !open && setSelectedBundle(null)}
      />
    </div>
  );
}
