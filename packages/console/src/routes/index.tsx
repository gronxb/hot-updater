import type { Bundle } from "@hot-updater/plugin-core";
import { createFileRoute } from "@tanstack/react-router";
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
  const { filters, bundleId, setBundleId } = useFilterParams();
  const activeBundleId = bundleId ?? "";

  const { data: bundlesData, isLoading } = useBundlesQuery({
    channel: filters.channel,
    platform: filters.platform,
    offset: filters.offset,
    limit: "20",
  });

  const bundles = bundlesData?.data ?? [];
  const selectedBundleFromList = activeBundleId
    ? (bundles.find((bundle) => bundle.id === activeBundleId) ?? null)
    : null;
  const { data: selectedBundleFromQuery, isPending: isSelectedBundlePending } =
    useBundleQuery(activeBundleId);
  const selectedBundle: Bundle | null =
    selectedBundleFromQuery ?? selectedBundleFromList;
  const isSelectedBundleLoading =
    Boolean(activeBundleId) && !selectedBundle && isSelectedBundlePending;

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
          selectedBundleId={bundleId}
          onRowClick={(bundle) => setBundleId(bundle.id)}
        />
      </div>

      <BundleEditorSheet
        bundleId={bundleId}
        bundle={selectedBundle}
        loading={isSelectedBundleLoading}
        open={Boolean(bundleId)}
        onOpenChange={(open) => !open && setBundleId(undefined)}
      />
    </div>
  );
}
