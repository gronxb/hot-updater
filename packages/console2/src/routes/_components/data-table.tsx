import {
  type ColumnDef,
  type Row,
  createSolidTable,
  flexRender,
  getCoreRowModel,
} from "@tanstack/solid-table";
import { type Accessor, For, splitProps } from "solid-js";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: Accessor<TData[] | undefined>;
  onRowClick: (data: TData) => void;
}

export function DataTable<TData, TValue>(props: DataTableProps<TData, TValue>) {
  const [local] = splitProps(props, ["columns", "data", "onRowClick"]);

  const table = createSolidTable({
    get data() {
      return local.data() || [];
    },
    columns: local.columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const handleRowClick = (row: Row<TData>) => () => {
    local.onRowClick(row.original);
  };

  return (
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
  );
}
