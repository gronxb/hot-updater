import { Button } from "@/components/ui/button";
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { createNativeBuildDownloadUrlQuery } from "@/lib/api";
import { Download, Hash, Package, Package2 } from "lucide-solid";
import { AiFillAndroid, AiFillApple } from "solid-icons/ai";
import { Show, createMemo } from "solid-js";
import type { NativeBuild } from "./native-builds-columns";

interface NativeBuildSheetContentProps {
  build: NativeBuild;
  onClose: () => void;
}

export function NativeBuildSheetContent(props: NativeBuildSheetContentProps) {
  const downloadUrlQuery = createNativeBuildDownloadUrlQuery(props.build.id);

  const downloadUrl = createMemo(() => {
    const data = downloadUrlQuery.data;
    if (data && "fileUrl" in data) {
      return data.fileUrl;
    }
    return undefined;
  });

  const handleDownload = () => {
    const url = downloadUrl();
    if (url) {
      window.open(url, "_blank");
    }
  };

  return (
    <SheetContent class="w-[400px] sm:w-[540px]">
      <SheetHeader>
        <SheetTitle class="flex items-center gap-2">
          <Show when={props.build.platform === "ios"}>
            <AiFillApple size={20} />
          </Show>
          <Show when={props.build.platform === "android"}>
            <AiFillAndroid size={20} color="#3DDC84" />
          </Show>
          Native Build Details
        </SheetTitle>
        <SheetDescription>
          View and manage native build information
        </SheetDescription>
      </SheetHeader>

      <div class="space-y-6 py-6">
        {/* Basic Information */}
        <div class="space-y-4">
          <h3 class="text-lg font-semibold">Basic Information</h3>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <label class="text-sm font-medium text-muted-foreground">
                Native Version
              </label>
              <div class="flex items-center gap-2">
                <Package size={16} />
                <span class="font-mono">{props.build.nativeVersion}</span>
              </div>
            </div>

            <div class="space-y-2">
              <label class="text-sm font-medium text-muted-foreground">
                Platform
              </label>
              <div class="flex items-center gap-2">
                <Show when={props.build.platform === "ios"}>
                  <AiFillApple size={16} />
                  <span>iOS</span>
                </Show>
                <Show when={props.build.platform === "android"}>
                  <AiFillAndroid size={16} color="#3DDC84" />
                  <span>Android</span>
                </Show>
              </div>
            </div>

            <div class="space-y-2">
              <label class="text-sm font-medium text-muted-foreground">
                Build ID
              </label>
              <div class="flex items-center gap-2">
                <Package2 size={16} />
                <span class="font-mono text-sm">{props.build.id}</span>
              </div>
            </div>

            <div class="space-y-2 col-span-2">
              <label class="text-sm font-medium text-muted-foreground">
                Fingerprint Hash
              </label>
              <div class="flex items-center gap-2">
                <Hash size={16} />
                <span class="font-mono text-sm break-all">
                  {props.build.fingerprintHash}
                </span>
              </div>
            </div>
          </div>
        </div>

        <hr class="border-gray-200" />

        {/* Bundle Compatibility */}
        <div class="space-y-4">
          <h3 class="text-lg font-semibold">Bundle Compatibility</h3>

          <div class="p-4 bg-blue-50 rounded-lg">
            <div class="flex items-start gap-3">
              <Package2 class="mt-0.5 text-blue-600" size={20} />
              <div class="space-y-1">
                <p class="text-sm font-medium text-blue-900">
                  Native Build Information
                </p>
                <p class="text-sm text-blue-700">
                  This native build (ID:{" "}
                  <span class="font-mono bg-blue-100 px-1 rounded">
                    {props.build.id}
                  </span>
                  ) serves as the minimum bundle identifier for compatibility.
                </p>
              </div>
            </div>
          </div>
        </div>

        <hr class="border-gray-200" />

        {/* Download Section */}
        <div class="space-y-4">
          <h3 class="text-lg font-semibold">Download</h3>

          <div class="space-y-3">
            <Show when={downloadUrlQuery.isLoading}>
              <div class="text-center p-4">
                <div class="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                <p class="mt-2 text-sm text-muted-foreground">
                  Generating download URL...
                </p>
              </div>
            </Show>

            <Show when={downloadUrlQuery.error}>
              <div class="p-4 bg-red-50 rounded-lg">
                <p class="text-sm text-red-700">
                  Failed to generate download URL:{" "}
                  {downloadUrlQuery.error?.message}
                </p>
              </div>
            </Show>

            <Show
              when={
                !downloadUrlQuery.isLoading &&
                !downloadUrlQuery.error &&
                downloadUrl()
              }
              fallback={
                <Show
                  when={!downloadUrlQuery.isLoading && !downloadUrlQuery.error}
                >
                  <div class="p-4 bg-gray-50 rounded-lg">
                    <p class="text-sm text-muted-foreground">
                      Download URL not available for this build.
                    </p>
                  </div>
                </Show>
              }
            >
              <Button
                onClick={handleDownload}
                class="w-full"
                size="lg"
                disabled={!downloadUrl()}
              >
                <Download class="mr-2 h-4 w-4" />
                Download Build
              </Button>

              <div class="p-3 bg-blue-50 rounded-lg">
                <p class="text-sm text-blue-700">
                  This will download the native build file for{" "}
                  {props.build.platform} version {props.build.nativeVersion}.
                </p>
              </div>
            </Show>
          </div>
        </div>

        <hr class="border-gray-200" />

        {/* Actions */}
        <div class="flex justify-end gap-2">
          <Button variant="outline" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </div>
    </SheetContent>
  );
}
