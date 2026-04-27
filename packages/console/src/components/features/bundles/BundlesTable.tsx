import type { Bundle, PaginationInfo } from "@hot-updater/plugin-core";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Fingerprint,
  Package,
} from "lucide-react";
import { Fragment } from "react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { EnabledStatusIcon } from "@/components/EnabledStatusIcon";
import { PlatformIcon } from "@/components/PlatformIcon";
import { RolloutPercentageBadge } from "@/components/RolloutPercentageBadge";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { useFilterParams } from "@/hooks/useFilterParams";
import { useBundleChildCountsQuery, useBundleChildrenQuery } from "@/lib/api";
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

function MobileStatusBadge({
  enabled,
  trueLabel,
  falseLabel,
  falseIcon = "x",
  trueTone = "success",
}: {
  enabled: boolean;
  trueLabel: string;
  falseLabel: string;
  falseIcon?: "minus" | "x";
  trueTone?: "success" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
        enabled
          ? trueTone === "warning"
            ? "bg-amber-500/14 text-amber-700 dark:text-amber-300"
            : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
          : falseIcon === "minus"
            ? "bg-muted text-muted-foreground"
            : "bg-red-500/12 text-red-700 dark:text-red-300",
      )}
    >
      <EnabledStatusIcon
        enabled={enabled}
        falseIcon={falseIcon}
        colorMode="inherit"
        className="h-3.5 w-3.5"
      />
      <span>{enabled ? trueLabel : falseLabel}</span>
    </span>
  );
}

export function BundlesTable({
  bundles,
  pagination,
  expandedBundleId,
  selectedBundleId,
  onExpandedBundleChange,
  onDetailClick,
}: BundlesTableProps) {
  const { setFilters } = useFilterParams();
  const isMobile = useIsMobile();
  const cursorPagination = pagination as CursorPaginationInfo | undefined;
  const bundleIds = bundles.map((bundle) => bundle.id);
  const { data: patchCountsByBundleId = {} } =
    useBundleChildCountsQuery(bundleIds);
  const { data: childBundles = [], isLoading: isChildBundlesLoading } =
    useBundleChildrenQuery(expandedBundleId ?? "");

  const bundleColumns = createBundleColumns({
    expandedBundleId,
    patchCountsByBundleId,
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
        {isMobile ? (
          <div className="flex flex-col">
            {bundles.length ? (
              bundles.map((bundle) => {
                const isExpanded = bundle.id === expandedBundleId;
                const panelId = `bundle-lineage-panel-${bundle.id}`;
                const rolloutCohortCount = bundle.rolloutCohortCount ?? 1000;
                const rolloutPercentage = rolloutCohortCount / 10;
                const patchCount = patchCountsByBundleId[bundle.id];

                return (
                  <div
                    key={bundle.id}
                    data-state={
                      bundle.id === selectedBundleId ? "selected" : undefined
                    }
                    className={cn(
                      "border-b border-border/60 last:border-b-0 data-[state=selected]:bg-muted/20",
                      isExpanded && "bg-primary/5",
                    )}
                  >
                    <button
                      type="button"
                      className="flex w-full flex-col gap-4 p-4 text-left"
                      onClick={() => onDetailClick(bundle)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-2">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                            Bundle
                          </div>
                          <div className="min-w-0 text-sm font-medium">
                            <BundleIdDisplay
                              bundleId={bundle.id}
                              maxLength={18}
                              fullOnMobile
                            />
                          </div>
                        </div>
                        <div className="shrink-0">
                          <ChannelBadge channel={bundle.channel} />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div className="rounded-md bg-muted/40 p-3">
                          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground/70">
                            Platform
                          </div>
                          <div className="flex items-center gap-2">
                            <PlatformIcon
                              platform={bundle.platform}
                              className="h-4 w-4"
                            />
                            <span>
                              {bundle.platform === "ios" ? "iOS" : "Android"}
                            </span>
                          </div>
                        </div>
                        <div className="rounded-md bg-muted/40 p-3">
                          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground/70">
                            Created
                          </div>
                          <div className="text-xs text-foreground">
                            <TimestampDisplay uuid={bundle.id} />
                          </div>
                        </div>
                        <div className="rounded-md bg-muted/40 p-3">
                          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground/70">
                            Rollout
                          </div>
                          <RolloutPercentageBadge
                            percentage={rolloutPercentage}
                          />
                        </div>
                        <div className="rounded-md bg-muted/40 p-3">
                          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground/70">
                            Patches
                          </div>
                          <div className="text-xs text-foreground">
                            {patchCount === undefined
                              ? "Checking"
                              : patchCount > 0
                                ? `${patchCount} ${
                                    patchCount === 1 ? "patch" : "patches"
                                  }`
                                : "-"}
                          </div>
                        </div>
                        <div className="rounded-md bg-muted/40 p-3">
                          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground/70">
                            Status
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <MobileStatusBadge
                              enabled={bundle.enabled}
                              trueLabel="Enabled"
                              falseLabel="Disabled"
                            />
                            {bundle.shouldForceUpdate ? (
                              <MobileStatusBadge
                                enabled={bundle.shouldForceUpdate}
                                trueLabel="Force update"
                                falseLabel="Optional"
                                falseIcon="minus"
                                trueTone="warning"
                              />
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-2 rounded-md border border-border/70 bg-background/80 p-3 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-muted-foreground">Target</span>
                          <div className="min-w-0 text-right">
                            {bundle.fingerprintHash ? (
                              <span
                                translate="no"
                                className="inline-flex min-w-0 items-start gap-2 font-mono text-xs"
                              >
                                <Fingerprint className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span className="break-all">
                                  {bundle.fingerprintHash}
                                </span>
                              </span>
                            ) : bundle.targetAppVersion ? (
                              <span
                                translate="no"
                                className="inline-flex items-center gap-2 text-xs"
                              >
                                <Package className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                {bundle.targetAppVersion}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                -
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-muted-foreground">Message</span>
                          <span className="min-w-0 text-right text-xs text-foreground/80">
                            {bundle.message || "-"}
                          </span>
                        </div>
                      </div>
                    </button>

                    <div className="border-t border-border/60 px-4 py-3">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-9 w-full justify-between px-3 text-sm"
                        aria-label={
                          isExpanded ? "Hide Lineage" : "Show Lineage"
                        }
                        aria-controls={panelId}
                        aria-expanded={isExpanded}
                        onClick={() =>
                          onExpandedBundleChange(
                            isExpanded ? undefined : bundle.id,
                          )
                        }
                      >
                        <span>
                          {patchCount === undefined
                            ? "Patch lineage"
                            : `Patch lineage (${patchCount})`}
                        </span>
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="h-4 w-4" aria-hidden="true" />
                        )}
                      </Button>
                    </div>

                    {isExpanded ? (
                      <BundleChildrenPanel
                        panelId={panelId}
                        bundle={bundle}
                        bundles={childBundles}
                        loading={isChildBundlesLoading}
                        onDetailClick={onDetailClick}
                      />
                    ) : null}
                  </div>
                );
              })
            ) : (
              <div className="flex h-32 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                No bundles found matching your filters.
              </div>
            )}
          </div>
        ) : (
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
                  const panelId = `bundle-lineage-panel-${row.original.id}`;

                  return (
                    <Fragment key={row.original.id}>
                      <TableRow
                        data-state={
                          row.original.id === selectedBundleId
                            ? "selected"
                            : undefined
                        }
                        className={cn(
                          "cursor-pointer transition-colors hover:bg-muted/10 focus-within:bg-muted/15 data-[state=selected]:bg-muted/15",
                          isExpanded && "bg-primary/5",
                        )}
                        onClick={() => onDetailClick(row.original)}
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
                              panelId={panelId}
                              bundle={row.original}
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
        )}
      </div>

      <div className="flex flex-col gap-3 px-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs font-medium text-muted-foreground">
          Showing <span className="text-foreground">{startEntry}</span> to{" "}
          <span className="text-foreground">{endEntry}</span> entries
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:justify-end">
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
            className="h-8 flex-1 px-3 text-xs sm:flex-none"
          >
            <ChevronLeft data-icon="inline-start" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNextPage}
            disabled={!hasNextPage}
            className="h-8 flex-1 px-3 text-xs sm:flex-none"
          >
            Next
            <ChevronRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </div>
  );
}
