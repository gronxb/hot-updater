import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBundlesByFingerprintQuery } from "@/lib/api";
import type { Bundle } from "@hot-updater/core";
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
} from "@tanstack/solid-table";
import { ChevronLeft, ChevronRight } from "lucide-solid";
import { For, Show, createSignal } from "solid-js";
import type { NativeBuild } from "./native-builds-columns";
import { OtaUpdatesTable } from "./ota-updates-table";

interface NativeBuildsDataTableProps {
  columns: ColumnDef<NativeBuild>[];
  data: NativeBuild[];
  onRowClick?: (build: NativeBuild) => void;
  onOtaRowClick?: (bundle: Bundle) => void;
  expandedRows?: Set<string>;
}

export function NativeBuildsDataTable(props: NativeBuildsDataTableProps) {
  const [sorting, setSorting] = createSignal<SortingState>([]);
  const [columnFilters, setColumnFilters] = createSignal<ColumnFiltersState>(
    [],
  );
  const [globalFilter, setGlobalFilter] = createSignal("");

  const table = createSolidTable<NativeBuild>({
    get data() {
      return props.data;
    },
    get columns() {
      return props.columns;
    },
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    get state() {
      return {
        sorting: sorting(),
        columnFilters: columnFilters(),
        globalFilter: globalFilter(),
      };
    },
  });

  return (
    <div class="space-y-4">
      {/* Table */}
      <div class="rounded-md border">
        <Table>
          <TableHeader>
            <For each={table.getHeaderGroups()}>
              {(headerGroup) => (
                <TableRow>
                  <For each={headerGroup.headers}>
                    {(header) => (
                      <TableHead>
                        <Show when={!header.isPlaceholder} fallback={null}>
                          <div
                            class={
                              header.column.getCanSort()
                                ? "cursor-pointer select-none flex items-center space-x-1"
                                : ""
                            }
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                          </div>
                        </Show>
                      </TableHead>
                    )}
                  </For>
                </TableRow>
              )}
            </For>
          </TableHeader>
          <TableBody>
            <Show
              when={table.getRowModel().rows?.length}
              fallback={
                <TableRow>
                  <TableCell
                    colSpan={props.columns.length}
                    class="h-24 text-center text-muted-foreground"
                  >
                    No native builds found.
                  </TableCell>
                </TableRow>
              }
            >
              <For each={table.getRowModel().rows}>
                {(row) => {
                  const isExpanded = () =>
                    props.expandedRows?.has(row.original.id) ?? false;

                  return (
                    <>
                      <TableRow
                        class="cursor-pointer hover:bg-gray-50"
                        onClick={() => props.onRowClick?.(row.original)}
                      >
                        <For each={row.getVisibleCells()}>
                          {(cell) => (
                            <TableCell>
                              {flexRender(
                                cell.column.columnDef.cell,
                                cell.getContext(),
                              )}
                            </TableCell>
                          )}
                        </For>
                      </TableRow>
                      <Show when={isExpanded()}>
                        <TableRow>
                          <TableCell colSpan={props.columns.length} class="p-0">
                            <ExpandedRowContent
                              build={row.original}
                              onOtaRowClick={props.onOtaRowClick}
                            />
                          </TableCell>
                        </TableRow>
                      </Show>
                    </>
                  );
                }}
              </For>
            </Show>
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div class="flex items-center justify-between">
        <div class="text-sm text-muted-foreground">
          {table.getRowModel().rows.length} of {props.data.length} row(s)
          displayed.
        </div>
        <div class="flex items-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <ChevronLeft class="h-4 w-4 mr-1" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
            <ChevronRight class="h-4 w-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ExpandedRowContent(props: {
  build: NativeBuild;
  onOtaRowClick?: (bundle: Bundle) => void;
}) {
  const bundlesQuery = useBundlesByFingerprintQuery(
    props.build.fingerprintHash,
  );

  return (
    <div class="bg-gray-50 border-t border-gray-200 p-4">
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <h4 class="text-sm font-semibold text-gray-900">
            Related OTA Updates ({bundlesQuery.data?.data?.length || 0})
          </h4>
        </div>

        <div class="text-sm text-gray-600">
          OTA bundles that are compatible with this native build (same
          fingerprint hash).
        </div>

        <Show
          when={!bundlesQuery.isLoading && bundlesQuery.data?.data}
          fallback={
            <div class="text-center py-8">
              <Show when={bundlesQuery.isLoading}>
                <div class="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
                <p class="mt-2 text-sm text-gray-500">Loading OTA updates...</p>
              </Show>
              <Show when={bundlesQuery.error}>
                <p class="text-sm text-red-600">Failed to load OTA updates</p>
              </Show>
            </div>
          }
        >
          <OtaUpdatesTable
            fingerprintHash={props.build.fingerprintHash}
            onRowClick={props.onOtaRowClick}
          />
        </Show>
      </div>
    </div>
  );
}
