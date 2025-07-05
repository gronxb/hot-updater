import { Sheet } from "@/components/ui/sheet";
import { useFilter } from "@/hooks/useFilter";
import { createNativeBuildsQuery, createNativeBuildQuery } from "@/lib/api";
import { Show, Suspense, createMemo, createSignal } from "solid-js";
import { NativeBuildSheetContent } from "./_components/native-build-sheet-content";
import { NativeBuilds } from "./_components/native-builds";

export default function NativeBuildsPage() {
  const { buildIdFilter, setBuildIdFilter } = useFilter();
  const [globalFilter, setGlobalFilter] = createSignal("");
  const [platformFilter, setPlatformFilter] = createSignal<"ios" | "android" | undefined>(undefined);
  const [channelFilter, setChannelFilter] = createSignal<string | undefined>(undefined);

  const nativeBuildsQuery = createNativeBuildsQuery(() => ({
    platform: platformFilter(),
    channel: channelFilter(),
    limit: "50",
    offset: "0",
  }));

  const selectedBuildQuery = createNativeBuildQuery(buildIdFilter() || "");

  const isOpen = createMemo(() => buildIdFilter() !== null);

  const handleClose = () => {
    setBuildIdFilter(null);
  };

  const handleRowClick = (buildId: string) => {
    setBuildIdFilter(buildId);
  };

  const nativeBuilds = createMemo(() => {
    const data = nativeBuildsQuery.data;
    if (!data || !data.data) return [];
    
    // Apply global filter if needed
    const filter = globalFilter().toLowerCase();
    if (!filter) return data.data;
    
    return data.data.filter(build => 
      build.nativeVersion.toLowerCase().includes(filter) ||
      build.platform.toLowerCase().includes(filter) ||
      build.fingerprintHash.toLowerCase().includes(filter) ||
      build.id.toLowerCase().includes(filter)
    );
  });

  return (
    <Sheet
      open={isOpen()}
      onOpenChange={(open) => {
        if (!open) {
          setBuildIdFilter(null);
        }
      }}
    >
      <NativeBuilds 
        data={nativeBuilds()}
        onRowClick={handleRowClick}
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
            onClose={handleClose}
          />
        </Suspense>
      </Show>
    </Sheet>
  );
}