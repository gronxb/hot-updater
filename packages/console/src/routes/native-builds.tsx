import { Sheet } from "@/components/ui/sheet";
import { useFilter } from "@/hooks/useFilter";
import { Show, Suspense, createMemo } from "solid-js";
import { NativeBuildSheetContent } from "./_components/native-build-sheet-content";
import { NativeBuilds } from "./_components/native-builds";

// Mock data for demonstration
const mockNativeBuilds = [
  {
    id: "build-1",
    nativeVersion: "1.0.0",
    platform: "ios" as const,
    fingerprintHash: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0",
    minBundleId: "bundle-min-001",
    downloadUrl: "https://example.com/download/ios/1.0.0",
    createdAt: new Date("2024-01-15T10:30:00Z"),
  },
  {
    id: "build-2",
    nativeVersion: "1.0.0",
    platform: "android" as const,
    fingerprintHash: "z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0",
    minBundleId: "bundle-min-001",
    downloadUrl: "https://example.com/download/android/1.0.0",
    createdAt: new Date("2024-01-15T09:15:00Z"),
  },
  {
    id: "build-3",
    nativeVersion: "1.0.1",
    platform: "ios" as const,
    fingerprintHash: "b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1",
    minBundleId: "bundle-min-002",
    downloadUrl: "https://example.com/download/ios/1.0.1",
    createdAt: new Date("2024-01-20T14:45:00Z"),
  },
  {
    id: "build-4",
    nativeVersion: "1.0.1",
    platform: "android" as const,
    fingerprintHash: "y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9",
    minBundleId: "bundle-min-002",
    downloadUrl: "https://example.com/download/android/1.0.1",
    createdAt: new Date("2024-01-20T13:20:00Z"),
  },
  {
    id: "build-5",
    nativeVersion: "1.1.0",
    platform: "ios" as const,
    fingerprintHash: "c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2",
    minBundleId: "bundle-min-003",
    createdAt: new Date("2024-01-25T16:10:00Z"),
  },
];

export default function NativeBuildsPage() {
  const { buildIdFilter, setBuildIdFilter } = useFilter();

  const isOpen = createMemo(() => buildIdFilter() !== null);
  const selectedBuild = createMemo(() => 
    mockNativeBuilds.find(build => build.id === buildIdFilter()) || null
  );

  const handleClose = () => {
    setBuildIdFilter(null);
  };

  const handleRowClick = (buildId: string) => {
    setBuildIdFilter(buildId);
  };

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
        data={mockNativeBuilds}
        onRowClick={handleRowClick}
      />
      <Show when={selectedBuild()}>
        <Suspense>
          <NativeBuildSheetContent
            build={selectedBuild()!}
            onClose={handleClose}
          />
        </Suspense>
      </Show>
    </Sheet>
  );
}