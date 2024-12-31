import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuIcon,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";

import {
  type ColumnDef,
  type PaginationState,
  type Row,
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
} from "@tanstack/solid-table";
import { type Accessor, For, createSignal, splitProps } from "solid-js";

import {
  Pagination,
  PaginationEllipsis,
  PaginationItem,
  PaginationItems,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Bundle, Platform } from "@hot-updater/core";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: Accessor<TData[] | undefined>;
  onRowClick: (data: TData) => void;
}

const DEFAULT_PAGE_SIZE = 20;

export function DataTable<TData, TValue>(props: DataTableProps<TData, TValue>) {
  const [local] = splitProps(props, ["columns", "data", "onRowClick"]);

  const [platformFilter, setPlatformFilter] = createSignal<Platform | null>(
    null,
  );
  const [pagination, setPagination] = createSignal<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  const table = createSolidTable({
    get data() {
      return local.data() || [];
    },
    columns: local.columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    state: {
      get pagination() {
        return pagination();
      },
      get globalFilter() {
        return platformFilter();
      },
    },
    onPaginationChange: setPagination,
    globalFilterFn: (row, _, filterValue) => {
      if (!filterValue) return true;
      const platform = (row.original as Bundle).platform.toLowerCase();
      return platform === filterValue;
    },
    manualPagination: false,
  });

  const handleRowClick = (row: Row<TData>) => () => {
    local.onRowClick(row.original);
  };

  return (
    <div>
      <div class="flex flex-row justify-end p-3">
        <NavigationMenu>
          <NavigationMenuItem>
            <NavigationMenuTrigger>
              {platformFilter() ? platformFilter() : "All"}
              <NavigationMenuIcon />
            </NavigationMenuTrigger>
            <NavigationMenuContent>
              <NavigationMenuLink onClick={() => setPlatformFilter(null)}>
                All
              </NavigationMenuLink>
              <NavigationMenuLink onClick={() => setPlatformFilter("ios")}>
                iOS
              </NavigationMenuLink>
              <NavigationMenuLink onClick={() => setPlatformFilter("android")}>
                Android
              </NavigationMenuLink>
            </NavigationMenuContent>
          </NavigationMenuItem>
        </NavigationMenu>
      </div>
      <div class="border rounded-md">
        <Table>
          <TableHeader>
            <For each={table.getHeaderGroups()}>
              {(headerGroup) => (
                <TableRow>
                  <For each={headerGroup.headers}>
                    {(header) => (
                      <TableHead>
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                      </TableHead>
                    )}
                  </For>
                </TableRow>
              )}
            </For>
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              <For each={table.getRowModel().rows}>
                {(row) => (
                  <TableRow
                    data-state={row.getIsSelected() && "selected"}
                    class="cursor-pointer"
                    onClick={handleRowClick(row)}
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
            ) : (
              <TableRow>
                <TableCell
                  colSpan={local.columns.length}
                  class="h-24 text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        class="mt-2.5 w-full [&>ul]:justify-center"
        itemComponent={(props) => (
          <PaginationItem
            page={props.page}
            onClick={() => table.setPageIndex(props.page - 1)}
          >
            {props.page}
          </PaginationItem>
        )}
        ellipsisComponent={() => <PaginationEllipsis />}
        count={Math.ceil((local.data()?.length ?? 0) / pagination().pageSize)}
      >
        <PaginationPrevious
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
        />
        <PaginationItems />
        <PaginationNext
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
        />
      </Pagination>
    </div>
  );
}
