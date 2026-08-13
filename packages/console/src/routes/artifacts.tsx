import type { Bundle } from "@hot-updater/plugin-core";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { BundleEditorSheet } from "@/components/features/bundles/BundleEditorSheet";
import { BundlesTable } from "@/components/features/bundles/BundlesTable";
import { FilterToolbar } from "@/components/features/bundles/FilterToolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { useFilterParams } from "@/hooks/useFilterParams";
import { useBundleQuery, useBundlesQuery } from "@/lib/api";

export const Route = createFileRoute("/artifacts")({
  component: ArtifactsPage,
  validateSearch: (search: Record<string, unknown>) => {
    const parsedPage =
      typeof search.page === "number"
        ? search.page
        : typeof search.page === "string"
          ? Number(search.page)
          : undefined;
    return {
      after: search.after as string | undefined,
      before: search.before as string | undefined,
      bundleId: search.bundleId as string | undefined,
      expandedBundleId: search.expandedBundleId as string | undefined,
      page:
        parsedPage !== undefined &&
        Number.isInteger(parsedPage) &&
        parsedPage > 1
          ? parsedPage
          : undefined,
      platform: search.platform as "ios" | "android" | undefined,
    };
  },
});

function ArtifactsPage() {
  const { filters, bundleId, setBundleId } = useFilterParams();
  const [expandedBundleId, setExpandedBundleId] = useState<
    string | undefined
  >();
  const activeBundleId = bundleId ?? "";
  const { data: bundlesData, isLoading } = useBundlesQuery({
    after: filters.after,
    before: filters.before,
    limit: "20",
    page: filters.page,
    platform: filters.platform,
  });
  const bundles = bundlesData?.data ?? [];
  const selectedBundleFromList = activeBundleId
    ? (bundles.find((bundle) => bundle.id === activeBundleId) ?? null)
    : null;
  const { data: selectedBundleFromQuery, isPending: isSelectedBundlePending } =
    useBundleQuery(activeBundleId);
  const selectedBundle: Bundle | null =
    selectedBundleFromQuery ?? selectedBundleFromList;

  useEffect(() => {
    if (
      expandedBundleId &&
      !bundles.some((bundle) => bundle.id === expandedBundleId)
    ) {
      setExpandedBundleId(undefined);
    }
  }, [bundles, expandedBundleId]);

  if (isLoading) {
    return (
      <div className="flex h-svh flex-col">
        <FilterToolbar />
        <div className="flex flex-1 flex-col gap-4 bg-muted/5 p-3 sm:p-6">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton className="h-12 w-full" key={index} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <FilterToolbar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 bg-muted/5 p-3 sm:p-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Immutable storage
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              Artifacts
            </h1>
          </div>
          <p className="max-w-lg text-right text-sm text-muted-foreground">
            Bundle hashes, manifests, patch lineage, and storage locations.
            Delivery policy lives in Releases.
          </p>
        </div>
        <BundlesTable
          bundles={bundles}
          expandedBundleId={expandedBundleId}
          onDetailClick={(bundle) => {
            setExpandedBundleId(undefined);
            setBundleId(bundle.id);
          }}
          onExpandedBundleChange={setExpandedBundleId}
          pagination={bundlesData?.pagination}
          selectedBundleId={bundleId}
        />
      </div>
      <BundleEditorSheet
        bundle={selectedBundle}
        bundleId={bundleId}
        loading={
          Boolean(activeBundleId) && !selectedBundle && isSelectedBundlePending
        }
        onOpenChange={(open) => !open && setBundleId(undefined)}
        open={Boolean(bundleId)}
      />
    </div>
  );
}
