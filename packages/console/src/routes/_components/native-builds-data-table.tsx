import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TextField } from "@/components/ui/text-field";
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
import { ChevronLeft, ChevronRight, Search } from "lucide-solid";
import { For, Show, createSignal } from "solid-js";
import type { NativeBuild } from "./native-builds-columns";

interface NativeBuildsDataTableProps {
  columns: ColumnDef<NativeBuild>[];
  data: NativeBuild[];
  onRowClick?: (row: NativeBuild) => void;
}

export function NativeBuildsDataTable(props: NativeBuildsDataTableProps) {
  const [sorting, setSorting] = createSignal<SortingState>([]);
  const [columnFilters, setColumnFilters] = createSignal<ColumnFiltersState>([]);
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
      {/* Search and Filters */}
      <div class="flex items-center space-x-2">
        <div class="relative flex-1 max-w-sm">
          <Search class="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <TextField
            placeholder="Search native builds..."
            value={globalFilter()}
            onInput={(e) => setGlobalFilter(e.currentTarget.value)}
            class="pl-8"
          />
        </div>
      </div>

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
                        <Show
                          when={!header.isPlaceholder}
                          fallback={null}
                        >
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
                            <Show when={header.column.getCanSort()}>
                              <span class="text-xs">
                                {{
                                  asc: " ↑",
                                  desc: " ↓",
                                }[header.column.getIsSorted() as string] ?? " ↕"}
                              </span>
                            </Show>
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
                {(row) => (
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
                )}
              </For>
            </Show>
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div class="flex items-center justify-between">
        <div class="text-sm text-muted-foreground">
          {table.getRowModel().rows.length} of {props.data.length} row(s) displayed.
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