import type { ActiveInstallationOverview } from "@hot-updater/plugin-core";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AnalyticsOverview } from "@/lib/analytics-overview";

const PAGE_SIZE = 8;

const percentage = (value: number): string =>
  new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(value);

export function BundleDistribution({
  active,
  catalog,
}: {
  readonly active: ActiveInstallationOverview;
  readonly catalog: AnalyticsOverview;
}) {
  const [page, setPage] = useState(1);
  const metadata = new Map(
    catalog.configuredRollouts.map(({ bundle, bundleId }) => [
      bundleId,
      bundle,
    ]),
  );

  if (active.bundles.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No active installations in this range.
      </p>
    );
  }

  const totalPages = Math.ceil(active.bundles.length / PAGE_SIZE);
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, active.bundles.length);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="overflow-x-auto">
        <Table aria-label="Active installations by bundle">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Bundle</TableHead>
              <TableHead className="hidden w-2/5 sm:table-cell">
                Activity
              </TableHead>
              <TableHead className="text-right">Active</TableHead>
              <TableHead className="text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {active.bundles.slice(start, end).map((row) => {
              const bundle = metadata.get(row.bundleId);
              const share = row.installations / active.activeInstallations;
              const shareLabel = percentage(share);
              return (
                <TableRow key={row.bundleId}>
                  <TableCell className="max-w-48 whitespace-normal">
                    <div className="flex min-w-0 flex-col gap-1">
                      <code className="break-all text-xs">{row.bundleId}</code>
                      <span className="text-muted-foreground">
                        {bundle
                          ? `${bundle.platform} · ${bundle.channel}`
                          : "Unknown bundle metadata"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Progress
                      aria-label={`${row.bundleId} activity share ${shareLabel}`}
                      aria-valuetext={shareLabel}
                      className="h-2"
                      value={share * 100}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.installations.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {shareLabel}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-4">
          <p className="text-xs text-muted-foreground tabular-nums">
            Showing {start + 1}–{end} of{" "}
            {active.bundles.length.toLocaleString()}
          </p>
          <div className="flex gap-2">
            <Button
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
              size="sm"
              type="button"
              variant="outline"
            >
              Previous
            </Button>
            <Button
              disabled={currentPage === totalPages}
              onClick={() => setPage(currentPage + 1)}
              size="sm"
              type="button"
              variant="outline"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
