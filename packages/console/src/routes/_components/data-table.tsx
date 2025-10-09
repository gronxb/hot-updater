import type { Bundle } from "@hot-updater/core";

import {
  type ColumnDef,
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  type PaginationState,
  type Row,
} from "@tanstack/solid-table";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  splitProps,
} from "solid-js";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuIcon,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
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
import { useFilter } from "@/hooks/useFilter";
import { useBundlesQuery, useChannelsQuery } from "@/lib/api";

interface DataTableProps {
  columns: ColumnDef<Bundle>[];
  onRowClick: (data: Bundle) => void;
}

const DEFAULT_PAGE_SIZE = 20;

const [pagination, setPagination] = createSignal<PaginationState>({
  pageIndex: 0,
  pageSize: DEFAULT_PAGE_SIZE,
});

export function DataTable(props: DataTableProps) {
  const [local] = splitProps(props, ["columns", "onRowClick"]);
  const { channelFilter, platformFilter, setPlatformFilter, setChannelFilter } =
    useFilter();

  const query = createMemo(() => ({
    channel: channelFilter() ?? undefined,
    platform: platformFilter() ?? undefined,
    limit: pagination().pageSize.toString(),
    offset: (pagination().pageIndex * pagination().pageSize).toString(),
  }));

  const bundlesQuery = useBundlesQuery(query);

  const bundlesResponse = createMemo(
    () => bundlesQuery.data ?? { data: [], pagination: null },
  );
  const bundles = createMemo(() => bundlesResponse().data ?? []);
  const serverPagination = createMemo(() => bundlesResponse().pagination);

  const table = createSolidTable({
    get data() {
      return bundles();
    },
    columns: local.columns,
    getCoreRowModel: getCoreRowModel(),
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
    manualPagination: true,
    pageCount: serverPagination()?.totalPages ?? 0,
  });

  const handleRowClick = (row: Row<Bundle>) => () => {
    local.onRowClick(row.original);
  };

  const channels = useChannelsQuery();

  createEffect(() => {
    if (channels.isFetched && channels.data && channelFilter() === null) {
      setChannelFilter(channels.data[0]);
    }
  });

  const handlePageChange = (newPageIndex: number) => {
    setPagination((prev) => ({
      ...prev,
      pageIndex: newPageIndex,
    }));
  };

  return (
    <div
      class="transition-opacity duration-300"
      classList={{
        "opacity-50": bundlesQuery.isFetching,
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
                <For
                  each={
                    [
                      { label: "All", value: null },
                      { label: "iOS", value: "ios" },
                      { label: "Android", value: "android" },
                    ] as const
                  }
                >
                  {(platform) => (
                    <NavigationMenuLink
                      classList={{
                        "bg-primary text-primary-foreground":
                          platform.value === platformFilter(),
                      }}
                      onClick={() => {
                        setPlatformFilter(platform.value);
                        setPagination((prev) => ({ ...prev, pageIndex: 0 }));
                      }}
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
                      classList={{
                        "bg-primary text-primary-foreground":
                          channel === channelFilter(),
                      }}
                      onClick={() => {
                        setChannelFilter(channel);
                        setPagination((prev) => ({ ...prev, pageIndex: 0 }));
                      }}
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
          "min-h-[400px]": bundlesQuery.isFetching,
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
            {bundlesQuery.isFetched && bundles().length === 0 ? (
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
            onClick={() => handlePageChange(props.page - 1)}
          >
            {props.page}
          </PaginationItem>
        )}
        ellipsisComponent={() => <PaginationEllipsis />}
        count={serverPagination()?.totalPages ?? 1}
      >
        <PaginationPrevious
          onClick={() => handlePageChange(pagination().pageIndex - 1)}
          disabled={!serverPagination()?.hasPreviousPage}
        />
        <PaginationItems />
        <PaginationNext
          onClick={() => handlePageChange(pagination().pageIndex + 1)}
          disabled={!serverPagination()?.hasNextPage}
        />
      </Pagination>

      {serverPagination() && (
        <div class="mt-2 text-sm text-muted-foreground text-center">
          Showing {pagination().pageIndex * pagination().pageSize + 1} to{" "}
          {Math.min(
            (pagination().pageIndex + 1) * pagination().pageSize,
            serverPagination()!.total,
          )}{" "}
          of {serverPagination()!.total} results
        </div>
      )}
    </div>
  );
}
