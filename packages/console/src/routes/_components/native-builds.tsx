import { Show } from "solid-js";
import {
  type NativeBuild,
  createNativeBuildsColumns,
} from "./native-builds-columns";
import { NativeBuildsDataTable } from "./native-builds-data-table";
import type { Bundle } from "@hot-updater/core";

interface NativeBuildsProps {
  data: NativeBuild[];
  onRowClick: (buildId: string) => void;
  onRowDetailClick: (build: NativeBuild) => void;
  onOtaRowClick: (bundle: Bundle) => void;
  expandedRows?: Set<string>;
  globalFilter?: string;
  setGlobalFilter?: (filter: string) => void;
  platformFilter?: "ios" | "android" | undefined;
  setPlatformFilter?: (platform: "ios" | "android" | undefined) => void;
  channelFilter?: string | undefined;
  setChannelFilter?: (channel: string | undefined) => void;
  isLoading?: boolean;
  error?: Error | null;
}

export function NativeBuilds(props: NativeBuildsProps) {
  const handleRowClick = (build: NativeBuild) => {
    props.onRowClick(build.id);
  };

  const handleRowDetailClick = (build: NativeBuild) => {
    props.onRowDetailClick(build);
  };

  const columns = createNativeBuildsColumns(handleRowDetailClick);

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

      <Show when={props.error}>
        <div class="text-red-500 p-4 border border-red-200 rounded-md bg-red-50">
          Error loading native builds: {props.error?.message}
        </div>
      </Show>

      <Show when={props.isLoading}>
        <div class="text-center p-8">
          <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900" />
          <p class="mt-2 text-muted-foreground">Loading native builds...</p>
        </div>
      </Show>

      <Show when={!props.isLoading && !props.error}>
        <NativeBuildsDataTable
          columns={columns}
          data={props.data}
          onRowClick={handleRowClick}
          onOtaRowClick={props.onOtaRowClick}
          expandedRows={props.expandedRows}
        />
      </Show>
    </div>
  );
}
