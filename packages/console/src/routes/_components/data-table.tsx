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
import {
  For,
  createEffect,
  createMemo,
  createSignal,
  splitProps,
} from "solid-js";

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
import { createBundlesQuery, createChannelsQuery } from "@/lib/api";
import type { Bundle, Platform } from "@hot-updater/core";

interface DataTableProps {
  columns: ColumnDef<Bundle>[];
  onRowClick: (data: Bundle) => void;
}

const DEFAULT_PAGE_SIZE = 20;

const [platformFilter, setPlatformFilter] = createSignal<Platform | null>(null);
const [channelFilter, setChannelFilter] = createSignal<string | null>(null);

const [pagination, setPagination] = createSignal<PaginationState>({
  pageIndex: 0,
  pageSize: DEFAULT_PAGE_SIZE,
});

export function DataTable(props: DataTableProps) {
  const [local] = splitProps(props, ["columns", "onRowClick"]);

  const query = createMemo(() => ({
    channel: channelFilter() ?? undefined,
    platform: platformFilter() ?? undefined,
    limit: pagination().pageSize.toString(),
    offset: (pagination().pageIndex * pagination().pageSize).toString(),
  }));

  const bundles = createBundlesQuery(query);

  const bundlesData = createMemo(() => bundles.data ?? []);

  const table = createSolidTable({
    get data() {
      return bundlesData();
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
      return (row.original as Bundle).platform.toLowerCase() === filterValue;
    },
    manualPagination: false,
  });

  const handleRowClick = (row: Row<Bundle>) => () => {
    local.onRowClick(row.original);
  };

  const channels = createChannelsQuery();

  createEffect(() => {
    if (channels.isFetched && channels.data && channelFilter() === null) {
      setChannelFilter(channels.data[0]);
    }
  });

  return (
    <div
      class="transition-opacity duration-300"
      classList={{
        "opacity-50": bundles.isFetching,
      }}
    >
      <div class="flex flex-row justify-end p-3">
        <div class="flex items-center gap-4">
          <div class="text-sm text-muted-foreground">Platform:</div>
          <NavigationMenu>
            <NavigationMenuItem>
              <NavigationMenuTrigger class="w-[100px]">
                {platformFilter() ? platformFilter() : "All"}
                <NavigationMenuIcon />
              </NavigationMenuTrigger>
              <NavigationMenuContent>
                <NavigationMenuLink onClick={() => setPlatformFilter(null)}>
                  All
                </NavigationMenuLink>
                <For
                  each={
                    [
                      { label: "iOS", value: "ios" },
                      { label: "Android", value: "android" },
                    ] as const
                  }
                >
                  {(platform) => (
                    <NavigationMenuLink
                      onClick={() => setPlatformFilter(platform.value)}
                    >
                      {platform.label}
                    </NavigationMenuLink>
                  )}
                </For>
              </NavigationMenuContent>
            </NavigationMenuItem>
          </NavigationMenu>

          <div class="text-sm text-muted-foreground">Channel:</div>
          <NavigationMenu>
            <NavigationMenuItem>
              <NavigationMenuTrigger class="w-[100px]">
                {channelFilter()}
                <NavigationMenuIcon />
              </NavigationMenuTrigger>
              <NavigationMenuContent>
                <For each={channels.data}>
                  {(channel) => (
                    <NavigationMenuLink
                      onClick={() => setChannelFilter(channel)}
                    >
                      {channel}
                    </NavigationMenuLink>
                  )}
                </For>
              </NavigationMenuContent>
            </NavigationMenuItem>
          </NavigationMenu>
        </div>
      </div>

      <div
        class="border rounded-md"
        classList={{
          "min-h-[400px]": bundles.isFetching,
        }}
      >
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
            {bundles.isFetched && table.getRowModel().rows?.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={local.columns.length}
                  class="h-full text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            ) : (
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
        count={Math.ceil((bundlesData()?.length ?? 0) / pagination().pageSize)}
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
