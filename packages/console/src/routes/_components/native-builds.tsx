import { createSignal } from "solid-js";
import { type NativeBuild, nativeBuildsColumns } from "./native-builds-columns";
import { NativeBuildsDataTable } from "./native-builds-data-table";

// Mock data for demonstration
const mockNativeBuilds: NativeBuild[] = [
  {
    id: "build-1",
    nativeVersion: "1.0.0",
    platform: "ios",
    fingerprintHash: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0",
    downloadUrl: "https://example.com/download/ios/1.0.0",
    createdAt: new Date("2024-01-15T10:30:00Z"),
  },
  {
    id: "build-2",
    nativeVersion: "1.0.0",
    platform: "android",
    fingerprintHash: "z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0",
    downloadUrl: "https://example.com/download/android/1.0.0",
    createdAt: new Date("2024-01-15T09:15:00Z"),
  },
  {
    id: "build-3",
    nativeVersion: "1.0.1",
    platform: "ios",
    fingerprintHash: "b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1",
    downloadUrl: "https://example.com/download/ios/1.0.1",
    createdAt: new Date("2024-01-20T14:45:00Z"),
  },
  {
    id: "build-4",
    nativeVersion: "1.0.1",
    platform: "android",
    fingerprintHash: "y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9",
    downloadUrl: "https://example.com/download/android/1.0.1",
    createdAt: new Date("2024-01-20T13:20:00Z"),
  },
  {
    id: "build-5",
    nativeVersion: "1.1.0",
    platform: "ios",
    fingerprintHash: "c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2",
    createdAt: new Date("2024-01-25T16:10:00Z"),
  },
];

export function NativeBuilds() {
  const [selectedBuild, setSelectedBuild] = createSignal<NativeBuild | null>(null);

  const handleRowClick = (build: NativeBuild) => {
    setSelectedBuild(build);
    console.log("Selected native build:", build);
  };

  return (
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-bold tracking-tight">Native Builds</h1>
          <p class="text-muted-foreground">
            Manage and download your native application builds
          </p>
        </div>
      </div>

      <NativeBuildsDataTable
        columns={nativeBuildsColumns}
        data={mockNativeBuilds}
        onRowClick={handleRowClick}
      />
    </div>
  );
}