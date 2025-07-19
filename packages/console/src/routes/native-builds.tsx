import { Sheet } from "@/components/ui/sheet";
import { useFilter } from "@/hooks/useFilter";
import { useNativeBuildQuery, useNativeBuildsQuery } from "@/lib/api";
import { Show, Suspense, createMemo, createSignal } from "solid-js";
import { NativeBuildSheetContent } from "./_components/native-build-sheet-content";
import { EditBundleSheetContent } from "./_components/edit-bundle-sheet-content";
import { NativeBuilds } from "./_components/native-builds";
import type { Bundle } from "@hot-updater/core";

export default function NativeBuildsPage() {
  const { buildIdFilter, setBuildIdFilter } = useFilter();
  const [bundleIdFilter, setBundleIdFilter] = createSignal<string | null>(null);
  const [globalFilter, setGlobalFilter] = createSignal("");
  const [platformFilter, setPlatformFilter] = createSignal<
    "ios" | "android" | undefined
  >(undefined);
  const [channelFilter, setChannelFilter] = createSignal<string | undefined>(
    undefined,
  );
  const [expandedRows, setExpandedRows] = createSignal<Set<string>>(new Set());

  const nativeBuildsQuery = useNativeBuildsQuery(() => ({
    platform: platformFilter(),
    channel: channelFilter(),
    limit: "50",
    offset: "0",
  }));

  const selectedBuildQuery = useNativeBuildQuery(buildIdFilter() || "");

  console.log("selectedBuildQuery.data:", selectedBuildQuery.data);

  const isBuildSheetOpen = createMemo(() => buildIdFilter() !== null);
  const isBundleSheetOpen = createMemo(() => bundleIdFilter() !== null);

  const handleBuildSheetClose = () => {
    setBuildIdFilter(null);
  };

  const handleBundleSheetClose = () => {
    setBundleIdFilter(null);
  };

  const handleRowClick = (buildId: string) => {
    setExpandedRows((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(buildId)) {
        newSet.delete(buildId);
      } else {
        newSet.add(buildId);
      }
      return newSet;
    });
  };

  const handleRowDetailClick = (build: any) => {
    console.log("Detail button clicked for build:", build.id);
    setBuildIdFilter(build.id);
  };

  const handleOtaRowClick = (bundle: Bundle) => {
    setBundleIdFilter(bundle.id);
  };

  const nativeBuilds = createMemo(() => {
    const data = nativeBuildsQuery.data;
    if (!data || !data.data) return [];

    // Apply global filter if needed
    const filter = globalFilter().toLowerCase();
    if (!filter) return data.data;

    return data.data.filter(
      (build) =>
        build.nativeVersion.toLowerCase().includes(filter) ||
        build.platform.toLowerCase().includes(filter) ||
        build.fingerprintHash.toLowerCase().includes(filter) ||
        build.id.toLowerCase().includes(filter),
    );
  });

  return (
    <>
      <Sheet
        open={isBuildSheetOpen()}
        onOpenChange={(open) => {
          if (!open) {
            setBuildIdFilter(null);
          }
        }}
      >
        <NativeBuilds
          data={nativeBuilds()}
          onRowClick={handleRowClick}
          onRowDetailClick={handleRowDetailClick}
          onOtaRowClick={handleOtaRowClick}
          expandedRows={expandedRows()}
          globalFilter={globalFilter()}
          setGlobalFilter={setGlobalFilter}
          platformFilter={platformFilter()}
          setPlatformFilter={setPlatformFilter}
          channelFilter={channelFilter()}
          setChannelFilter={setChannelFilter}
          isLoading={nativeBuildsQuery.isLoading}
          error={nativeBuildsQuery.error}
        />
        <Show when={buildIdFilter() && selectedBuildQuery.data}>
          <Suspense>
            <NativeBuildSheetContent
              build={selectedBuildQuery.data!}
              onClose={handleBuildSheetClose}
            />
          </Suspense>
        </Show>
      </Sheet>

      <Sheet
        open={isBundleSheetOpen()}
        onOpenChange={(open) => {
          if (!open) {
            setBundleIdFilter(null);
          }
        }}
      >
        <Show when={bundleIdFilter()}>
          <Suspense>
            <EditBundleSheetContent
              bundleId={bundleIdFilter()!}
              onClose={handleBundleSheetClose}
            />
          </Suspense>
        </Show>
      </Sheet>
    </>
  );
}
