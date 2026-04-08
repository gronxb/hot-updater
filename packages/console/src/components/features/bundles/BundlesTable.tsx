import type { Bundle, PaginationInfo } from "@hot-updater/plugin-core";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight } from "lucide-react";

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
  pagination?: PaginationInfo;
  selectedBundleId?: string;
  onRowClick: (bundle: Bundle) => void;
}

export function BundlesTable({
  bundles,
  pagination,
  selectedBundleId,
  onRowClick,
}: BundlesTableProps) {
  const { setFilters } = useFilterParams();

  const table = useReactTable({
    data: bundles,
    columns: bundleColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  const handlePreviousPage = () => {
    const previousCursor = pagination?.previousCursor ?? bundles[0]?.id;
    if (!previousCursor) {
      return;
    }
    setFilters({
      after: undefined,
      before: previousCursor,
    });
  };

  const handleNextPage = () => {
    const nextCursor = pagination?.nextCursor ?? bundles.at(-1)?.id;
    if (!nextCursor) {
      return;
    }
    setFilters({
      after: nextCursor,
      before: undefined,
    });
  };

  const hasNextPage = pagination?.hasNextPage ?? false;
  const hasPreviousPage = pagination?.hasPreviousPage ?? false;
  const currentPage = pagination?.currentPage ?? 1;
  const startEntry =
    bundles.length === 0 ? 0 : (currentPage - 1) * DEFAULT_PAGE_LIMIT + 1;
  const endEntry = startEntry === 0 ? 0 : startEntry + bundles.length - 1;

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
                <TableRow
                  key={row.id}
                  data-state={
                    row.original.id === selectedBundleId
                      ? "selected"
                      : undefined
                  }
                  onClick={() => onRowClick(row.original)}
                  className="cursor-pointer hover:bg-muted/30 transition-colors data-[state=selected]:bg-muted"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="py-3">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
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
          Showing <span className="text-foreground">{startEntry}</span> to{" "}
          <span className="text-foreground">{endEntry}</span> entries
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
