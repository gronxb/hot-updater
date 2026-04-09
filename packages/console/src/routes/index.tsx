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
    const parsedPage =
      typeof search.page === "number"
        ? search.page
        : typeof search.page === "string"
          ? Number(search.page)
          : undefined;

    return {
      channel: search.channel as string | undefined,
      platform: search.platform as "ios" | "android" | undefined,
      page:
        parsedPage !== undefined &&
        Number.isInteger(parsedPage) &&
        parsedPage > 1
          ? parsedPage
          : undefined,
      after: search.after as string | undefined,
      before: search.before as string | undefined,
      bundleId: search.bundleId as string | undefined,
      expandedBundleId: search.expandedBundleId as string | undefined,
    };
  },
});

function BundlesPage() {
  const {
    filters,
    bundleId,
    expandedBundleId,
    setBundleId,
    setExpandedBundleId,
  } = useFilterParams();
  const activeBundleId = bundleId ?? "";

  const { data: bundlesData, isLoading } = useBundlesQuery({
    channel: filters.channel,
    platform: filters.platform,
    page: filters.page,
    after: filters.after,
    before: filters.before,
    limit: "20",
  });

  const bundles = bundlesData?.data ?? [];
  const pagination = bundlesData?.pagination;
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
        <div className="flex flex-1 flex-col gap-4 bg-muted/5 p-6">
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
      <div className="flex flex-1 flex-col gap-6 bg-muted/5 p-6">
        <BundlesTable
          bundles={bundles}
          pagination={pagination}
          expandedBundleId={expandedBundleId}
          selectedBundleId={bundleId}
          onExpandedBundleChange={setExpandedBundleId}
          onDetailClick={(bundle) => setBundleId(bundle.id)}
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
