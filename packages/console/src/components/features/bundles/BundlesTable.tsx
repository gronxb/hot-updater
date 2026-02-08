import type { Bundle } from "@hot-updater/plugin-core";
import {
  type Row,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { memo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFilterParams } from "@/hooks/useFilterParams";
import { DEFAULT_PAGE_LIMIT } from "@/lib/constants";
import { bundleColumns } from "./BundleTableColumns";

interface BundlesTableProps {
  bundles: Bundle[];
  onRowClick: (bundle: Bundle) => void;
}

// Memoized table row to prevent unnecessary re-renders
const BundleTableRow = memo(
  ({
    row,
    onRowClick,
  }: {
    row: Row<Bundle>;
    onRowClick: (bundle: Bundle) => void;
  }) => {
    const handleClick = useCallback(() => {
      onRowClick(row.original);
    }, [row.original, onRowClick]);

    return (
      <TableRow
        onClick={handleClick}
        className="cursor-pointer hover:bg-muted/30 transition-colors data-[state=selected]:bg-muted"
      >
        {row.getVisibleCells().map((cell) => (
          <TableCell key={cell.id} className="py-3">
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        ))}
      </TableRow>
    );
  },
);

BundleTableRow.displayName = "BundleTableRow";

export function BundlesTable({ bundles, onRowClick }: BundlesTableProps) {
  const { filters, setFilters } = useFilterParams();
  const currentOffset = Number(filters.offset || 0);

  const table = useReactTable({
    data: bundles,
    columns: bundleColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  const handlePreviousPage = () => {
    const newOffset = Math.max(0, currentOffset - DEFAULT_PAGE_LIMIT);
    setFilters({ offset: newOffset.toString() });
  };

  const handleNextPage = () => {
    const newOffset = currentOffset + DEFAULT_PAGE_LIMIT;
    setFilters({ offset: newOffset.toString() });
  };

  const hasNextPage = bundles.length === DEFAULT_PAGE_LIMIT;
  const hasPreviousPage = currentOffset > 0;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/40">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="hover:bg-transparent border-b border-border/60"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="h-10 text-xs font-semibold uppercase text-muted-foreground/70"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <BundleTableRow
                  key={row.id}
                  row={row}
                  onRowClick={onRowClick}
                />
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={bundleColumns.length}
                  className="h-32 text-center text-muted-foreground"
                >
                  No bundles found matching your filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between px-2">
        <div className="text-xs text-muted-foreground font-medium">
          Showing <span className="text-foreground">{currentOffset + 1}</span>{" "}
          to{" "}
          <span className="text-foreground">
            {currentOffset + bundles.length}
          </span>{" "}
          entries
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePreviousPage}
            disabled={!hasPreviousPage}
            className="h-8 px-3 text-xs"
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNextPage}
            disabled={!hasNextPage}
            className="h-8 px-3 text-xs"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
