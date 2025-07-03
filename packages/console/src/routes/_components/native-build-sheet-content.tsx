import { Button } from "@/components/ui/button";
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Calendar, Download, Hash, Package, Package2 } from "lucide-solid";
import { AiFillAndroid, AiFillApple } from "solid-icons/ai";
import { Show } from "solid-js";
import type { NativeBuild } from "./native-builds-columns";

interface NativeBuildSheetContentProps {
  build: NativeBuild;
  onClose: () => void;
}

export function NativeBuildSheetContent(props: NativeBuildSheetContentProps) {
  const handleDownload = () => {
    if (props.build.downloadUrl) {
      window.open(props.build.downloadUrl, '_blank');
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
                Min Bundle ID
              </label>
              <div class="flex items-center gap-2">
                <Package2 size={16} />
                <Show 
                  when={props.build.minBundleId}
                  fallback={<span class="text-muted-foreground text-sm">N/A</span>}
                >
                  <span class="font-mono text-sm">{props.build.minBundleId}</span>
                </Show>
              </div>
            </div>

            <div class="space-y-2">
              <label class="text-sm font-medium text-muted-foreground">
                Created At
              </label>
              <div class="flex items-center gap-2">
                <Calendar size={16} />
                <span class="text-sm">
                  {props.build.createdAt.toLocaleDateString()} {props.build.createdAt.toLocaleTimeString()}
                </span>
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
                <p class="text-sm font-medium text-blue-900">Minimum Bundle Requirement</p>
                <Show 
                  when={props.build.minBundleId}
                  fallback={
                    <p class="text-sm text-blue-700">
                      No minimum bundle requirement set for this build.
                    </p>
                  }
                >
                  <p class="text-sm text-blue-700">
                    This native build requires at least bundle{" "}
                    <span class="font-mono bg-blue-100 px-1 rounded">
                      {props.build.minBundleId}
                    </span>{" "}
                    or newer to function properly.
                  </p>
                </Show>
              </div>
            </div>
          </div>
        </div>

        <hr class="border-gray-200" />

        {/* Download Section */}
        <div class="space-y-4">
          <h3 class="text-lg font-semibold">Download</h3>
          
          <div class="space-y-3">
            <Show 
              when={props.build.downloadUrl}
              fallback={
                <div class="p-4 bg-gray-50 rounded-lg">
                  <p class="text-sm text-muted-foreground">
                    Download URL not available for this build.
                  </p>
                </div>
              }
            >
              <Button
                onClick={handleDownload}
                class="w-full"
                size="lg"
              >
                <Download class="mr-2 h-4 w-4" />
                Download Build
              </Button>
              
              <div class="p-3 bg-blue-50 rounded-lg">
                <p class="text-sm text-blue-700">
                  This will download the native build file for {props.build.platform} version {props.build.nativeVersion}.
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