import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBundlesByFingerprintQuery } from "@/lib/api";
import { extractDateFromUUIDv7 } from "@/lib/utils";
import type { Bundle } from "@hot-updater/core";
import {
  type ColumnDef,
  createSolidTable,
  flexRender,
  getCoreRowModel,
} from "@tanstack/solid-table";
import dayjs from "dayjs";
import { Check, X } from "lucide-solid";
import { AiFillAndroid, AiFillApple } from "solid-icons/ai";
import { For, Show, createMemo } from "solid-js";

const otaUpdatesColumns: ColumnDef<Bundle>[] = [
  {
    accessorKey: "id",
    header: "Bundle ID",
    cell: (info) => {
      const id = info.getValue() as string;
      return (
        <Tooltip openDelay={0} closeDelay={0}>
          <TooltipTrigger class="font-mono text-sm">
            {id.slice(-8)}
          </TooltipTrigger>
          <TooltipContent>
            <p class="font-mono text-sm">{id}</p>
          </TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    accessorKey: "platform",
    header: "Platform",
    cell: (info) => {
      switch (info.getValue()) {
        case "ios":
          return (
            <div class="flex items-center gap-2">
              <AiFillApple size={16} />
              <span>iOS</span>
            </div>
          );
        case "android":
          return (
            <div class="flex items-center gap-2">
              <AiFillAndroid size={16} color="#3DDC84" />
              <span>Android</span>
            </div>
          );
        default:
          return info.getValue() as string;
      }
    },
  },
  {
    accessorKey: "enabled",
    header: "Status",
    cell: (info) => {
      const enabled = info.getValue() as boolean;
      return (
        <div class="flex items-center gap-2">
          {enabled ? (
            <>
              <Check class="text-green-600" size={16} />
              <span class="text-green-600">Enabled</span>
            </>
          ) : (
            <>
              <X class="text-red-600" size={16} />
              <span class="text-red-600">Disabled</span>
            </>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: "shouldForceUpdate",
    header: "Force Update",
    cell: (info) => {
      const shouldForceUpdate = info.getValue() as boolean;
      return shouldForceUpdate ? (
        <Check class="text-orange-600" size={16} />
      ) : (
        <X class="text-gray-400" size={16} />
      );
    },
  },
  {
    accessorKey: "id",
    header: "Created At",
    cell: (info) =>
      dayjs(extractDateFromUUIDv7(String(info.getValue()))).format(
        "YYYY-MM-DD HH:mm:ss",
      ),
  },
];

interface OtaUpdatesTableProps {
  fingerprintHash: string;
  onRowClick?: (bundle: Bundle) => void;
}

export function OtaUpdatesTable(props: OtaUpdatesTableProps) {
  const bundlesQuery = useBundlesByFingerprintQuery(props.fingerprintHash);

  const bundles = createMemo(() => bundlesQuery.data?.data || []);

  const table = createSolidTable({
    get data() {
      return bundles();
    },
    columns: otaUpdatesColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div class="space-y-4">
      <Show when={bundlesQuery.isLoading}>
        <div class="flex justify-center py-8">
          <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
        </div>
      </Show>

      <Show
        when={!bundlesQuery.isLoading && bundlesQuery.data?.data?.length === 0}
      >
        <div class="text-center py-8 text-muted-foreground">
          No OTA updates found for this native build.
        </div>
      </Show>

      <Show
        when={
          !bundlesQuery.isLoading &&
          bundlesQuery.data?.data &&
          bundlesQuery.data.data.length > 0
        }
      >
        <div class="rounded-md border">
          <table class="w-full">
            <thead>
              <For each={table.getHeaderGroups()}>
                {(headerGroup) => (
                  <tr class="border-b bg-muted/50">
                    <For each={headerGroup.headers}>
                      {(header) => (
                        <th class="h-10 px-4 text-left align-middle font-medium text-muted-foreground">
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )}
                        </th>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </thead>
            <tbody>
              <For each={table.getRowModel().rows}>
                {(row) => (
                  <tr
                    class={`border-b transition-colors hover:bg-muted/50 ${props.onRowClick ? "cursor-pointer" : ""}`}
                    onClick={() => props.onRowClick?.(row.original)}
                  >
                    <For each={row.getVisibleCells()}>
                      {(cell) => (
                        <td class="p-4 align-middle">
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}
