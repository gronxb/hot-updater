import type { Bundle, PaginationInfo } from "@hot-updater/plugin-core";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Fragment } from "react";

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
import { useBundleChildrenQuery } from "@/lib/api";
import { DEFAULT_PAGE_LIMIT } from "@/lib/constants";
import { cn } from "@/lib/utils";

import { BundleChildrenPanel } from "./BundleChildrenPanel";
import { createBundleColumns } from "./BundleTableColumns";

interface BundlesTableProps {
  bundles: Bundle[];
  pagination?: PaginationInfo;
  expandedBundleId?: string;
  selectedBundleId?: string;
  onExpandedBundleChange: (bundleId: string | undefined) => void;
  onDetailClick: (bundle: Bundle) => void;
}

type CursorPaginationInfo = PaginationInfo & {
  nextCursor?: string | null;
  previousCursor?: string | null;
};

export function BundlesTable({
  bundles,
  pagination,
  expandedBundleId,
  selectedBundleId,
  onExpandedBundleChange,
  onDetailClick,
}: BundlesTableProps) {
  const { setFilters } = useFilterParams();
  const cursorPagination = pagination as CursorPaginationInfo | undefined;
  const bundleMap = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  const depthByBundleId: Record<string, number> = {};
  const { data: childBundles = [], isLoading: isChildBundlesLoading } =
    useBundleChildrenQuery(expandedBundleId ?? "");

  const getDepth = (bundleId: string, stack = new Set<string>()): number => {
    if (depthByBundleId[bundleId] !== undefined) {
      return depthByBundleId[bundleId];
    }

    if (stack.has(bundleId)) {
      depthByBundleId[bundleId] = 0;
      return 0;
    }

    const bundle = bundleMap.get(bundleId);
    const baseBundleId = bundle?.metadata?.diff_base_bundle_id;
    if (!bundle || !baseBundleId || !bundleMap.has(baseBundleId)) {
      depthByBundleId[bundleId] = 0;
      return 0;
    }

    const nextStack = new Set(stack);
    nextStack.add(bundleId);
    depthByBundleId[bundleId] = getDepth(baseBundleId, nextStack) + 1;
    return depthByBundleId[bundleId];
  };

  for (const bundle of bundles) {
    getDepth(bundle.id);
  }

  const bundleColumns = createBundleColumns({
    depthByBundleId,
    expandedBundleId,
    onDetailClick,
    onToggleExpand: (bundle) =>
      onExpandedBundleChange(
        expandedBundleId === bundle.id ? undefined : bundle.id,
      ),
  });

  const table = useReactTable({
    data: bundles,
    columns: bundleColumns,
    getCoreRowModel: getCoreRowModel(),
  });
  const hasNextPage = pagination?.hasNextPage ?? false;
  const hasPreviousPage = pagination?.hasPreviousPage ?? false;
  const currentPage = pagination?.currentPage ?? 1;
  const totalPages = pagination?.totalPages ?? 0;

  const handlePreviousPage = () => {
    const previousCursor = cursorPagination?.previousCursor ?? bundles[0]?.id;
    if (!previousCursor) {
      return;
    }
    setFilters({
      page: Math.max(1, currentPage - 1),
      after: undefined,
      before: previousCursor,
    });
  };

  const handleNextPage = () => {
    const nextCursor = cursorPagination?.nextCursor ?? bundles.at(-1)?.id;
    if (!nextCursor) {
      return;
    }
    setFilters({
      page: currentPage + 1,
      after: nextCursor,
      before: undefined,
    });
  };
  const startEntry =
    bundles.length === 0 ? 0 : (currentPage - 1) * DEFAULT_PAGE_LIMIT + 1;
  const endEntry = startEntry === 0 ? 0 : startEntry + bundles.length - 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm">
        <Table>
          <TableHeader className="bg-muted/40">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="border-b border-border/60 hover:bg-transparent"
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
              table.getRowModel().rows.map((row) => {
                const isExpanded = row.original.id === expandedBundleId;

                return (
                  <Fragment key={row.original.id}>
                    <TableRow
                      data-state={
                        row.original.id === selectedBundleId
                          ? "selected"
                          : undefined
                      }
                      onClick={() =>
                        onExpandedBundleChange(
                          isExpanded ? undefined : row.original.id,
                        )
                      }
                      className={cn(
                        "cursor-pointer transition-colors hover:bg-muted/30 data-[state=selected]:bg-muted",
                        isExpanded && "bg-muted/20",
                      )}
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

                    {isExpanded ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={bundleColumns.length}
                          className="border-t-0 p-0"
                        >
                          <BundleChildrenPanel
                            baseBundle={row.original}
                            bundles={childBundles}
                            loading={isChildBundlesLoading}
                            onDetailClick={onDetailClick}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })
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
        <div className="text-xs font-medium text-muted-foreground">
          Showing <span className="text-foreground">{startEntry}</span> to{" "}
          <span className="text-foreground">{endEntry}</span> entries
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            Page <span className="text-foreground">{currentPage}</span>
            {totalPages > 0 ? (
              <>
                {" "}
                of <span className="text-foreground">{totalPages}</span>
              </>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePreviousPage}
            disabled={!hasPreviousPage}
            className="h-8 px-3 text-xs"
          >
            <ChevronLeft data-icon="inline-start" />
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
            <ChevronRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </div>
  );
}
