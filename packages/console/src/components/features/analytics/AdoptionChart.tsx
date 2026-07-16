import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BundleAdoption } from "@/lib/analytics-overview";

const chartConfig = {
  trackedInstallations: {
    label: "Tracked installations",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const percentage = (share: number): string =>
  new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(share);

const CHART_ITEM_LIMIT = 8;
const ADOPTION_PAGE_SIZE = 8;

export function AdoptionChart({
  adoption,
}: {
  readonly adoption: readonly BundleAdoption[];
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(
    1,
    Math.ceil(adoption.length / ADOPTION_PAGE_SIZE),
  );
  const currentPage = Math.min(page, totalPages);
  const rangeStart = (currentPage - 1) * ADOPTION_PAGE_SIZE;
  const rangeEnd = Math.min(rangeStart + ADOPTION_PAGE_SIZE, adoption.length);
  const visibleAdoption = adoption.slice(rangeStart, rangeEnd);
  const chartAdoption = adoption.slice(0, CHART_ITEM_LIMIT);

  return (
    <div className="flex flex-col gap-5">
      {adoption.length > CHART_ITEM_LIMIT ? (
        <p className="text-sm text-muted-foreground">
          Showing top {Math.min(CHART_ITEM_LIMIT, adoption.length)} of{" "}
          {adoption.length.toLocaleString()} observed bundles by tracked
          installations.
        </p>
      ) : null}
      <ChartContainer
        aria-label="Observed bundle adoption"
        className="h-56 w-full aspect-auto"
        config={chartConfig}
      >
        <BarChart
          accessibilityLayer
          data={chartAdoption}
          layout="vertical"
          margin={{ left: 8, right: 12 }}
        >
          <CartesianGrid horizontal={false} />
          <XAxis allowDecimals={false} axisLine={false} type="number" />
          <YAxis
            axisLine={false}
            dataKey="bundleId"
            tickFormatter={(value: string) =>
              value.length > 12 ? `${value.slice(0, 9)}…` : value
            }
            tickLine={false}
            type="category"
            width={88}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value) => (
                  <span className="font-mono font-medium tabular-nums">
                    {Number(value).toLocaleString()} tracked
                  </span>
                )}
                hideLabel={false}
              />
            }
          />
          <Bar
            dataKey="trackedInstallations"
            fill="var(--color-trackedInstallations)"
            isAnimationActive={false}
            radius={[0, 3, 3, 0]}
          />
        </BarChart>
      </ChartContainer>

      <Table aria-label="Observed adoption details">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Bundle</TableHead>
            <TableHead>Observed adoption</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleAdoption.map((item) => (
            <TableRow key={item.bundleId}>
              <TableCell className="max-w-56 whitespace-normal">
                <div className="flex flex-col gap-1">
                  <code className="break-all text-xs">{item.bundleId}</code>
                  {item.bundle ? (
                    <span className="text-muted-foreground">
                      {item.bundle.platform} · {item.bundle.channel}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      Bundle metadata unavailable
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="tabular-nums">
                {item.trackedInstallations.toLocaleString()} tracked ·{" "}
                {percentage(item.observedShare)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {adoption.length > ADOPTION_PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground tabular-nums">
            Showing {adoption.length === 0 ? 0 : rangeStart + 1}–{rangeEnd} of{" "}
            {adoption.length.toLocaleString()} observed bundles
          </p>
          <div className="flex items-center gap-2">
            <Button
              aria-label="Previous observed bundles page"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
              type="button"
              variant="outline"
            >
              Previous
            </Button>
            <Button
              aria-label="Next observed bundles page"
              disabled={currentPage === totalPages}
              onClick={() => setPage(currentPage + 1)}
              type="button"
              variant="outline"
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
