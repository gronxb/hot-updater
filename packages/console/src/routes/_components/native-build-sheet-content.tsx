import { Button } from "@/components/ui/button";
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useBundlesByFingerprintQuery,
  useNativeBuildDownloadUrlQuery,
} from "@/lib/api";
import {
  Download,
  HardDrive,
  Hash,
  Package,
  Package2,
  Tag,
} from "lucide-solid";
import { AiFillAndroid, AiFillApple } from "solid-icons/ai";
import { Show, createMemo, createSignal } from "solid-js";
import type { NativeBuild } from "./native-builds-columns";

interface NativeBuildSheetContentProps {
  build: NativeBuild;
  onClose: () => void;
}

export function NativeBuildSheetContent(props: NativeBuildSheetContentProps) {
  console.log("NativeBuildSheetContent props.build:", props.build);
  const downloadUrlQuery = useNativeBuildDownloadUrlQuery(props.build.id);
  const bundlesQuery = useBundlesByFingerprintQuery(
    props.build.fingerprintHash,
  );
  const [otaUpdatesOpen, setOtaUpdatesOpen] = createSignal(false);

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

          {/* Native Version and Platform - side by side */}
          <div class="flex gap-4">
            <div class="flex-1 space-y-2">
              <label
                for="nativeVersion"
                class="text-sm font-medium text-muted-foreground"
              >
                Native Version
              </label>
              <div class="flex items-center gap-2">
                <Package size={16} />
                <span class="font-mono">{props.build.nativeVersion}</span>
              </div>
            </div>

            <div class="flex-1 space-y-2">
              <label
                for="platform"
                class="text-sm font-medium text-muted-foreground"
              >
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
          </div>

          {/* Other fields - full width */}
          <div class="space-y-4">
            <div class="space-y-2">
              <label
                for="buildId"
                class="text-sm font-medium text-muted-foreground"
              >
                Min Bundle ID
              </label>
              <div class="flex gap-2">
                <Package2 size={16} />
                <Tooltip openDelay={0} closeDelay={0}>
                  <TooltipTrigger class="font-mono text-sm">
                    {props.build.id.slice(0, 8)}
                  </TooltipTrigger>
                  <TooltipContent>
                    <p class="font-mono text-sm">{props.build.id}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div class="space-y-2">
              <label
                for="channel"
                class="text-sm font-medium text-muted-foreground"
              >
                Channel
              </label>
              <div class="flex items-center gap-2">
                <Tag size={16} />
                <span class="font-mono">{props.build.channel}</span>
              </div>
            </div>

            <div class="space-y-2">
              <label
                for="fileSize"
                class="text-sm font-medium text-muted-foreground"
              >
                File Size
              </label>
              <div class="flex items-center gap-2">
                <HardDrive size={16} />
                <span class="text-sm">
                  {(props.build.fileSize / 1024 / 1024).toFixed(2)} MB
                </span>
              </div>
            </div>

            <div class="space-y-2">
              <label
                for="fingerprintHash"
                class="text-sm font-medium text-muted-foreground"
              >
                Fingerprint Hash
              </label>
              <div class="flex gap-2">
                <Hash size={16} />
                <Tooltip openDelay={0} closeDelay={0}>
                  <TooltipTrigger class="font-mono text-sm">
                    {props.build.fingerprintHash.slice(0, 8)}
                  </TooltipTrigger>
                  <TooltipContent>
                    <p class="font-mono text-sm">
                      {props.build.fingerprintHash}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>

        <hr class="border-gray-200" />

        {/* Metadata */}
        <Show
          when={
            props.build.metadata && Object.keys(props.build.metadata).length > 0
          }
        >
          <div class="space-y-4">
            <h3 class="text-lg font-semibold">Metadata</h3>
            <div class="p-4 bg-gray-50 rounded-lg">
              <pre class="text-sm font-mono overflow-x-auto">
                {JSON.stringify(props.build.metadata, null, 2)}
              </pre>
            </div>
          </div>
          <hr class="border-gray-200" />
        </Show>

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
                <div class="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
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
