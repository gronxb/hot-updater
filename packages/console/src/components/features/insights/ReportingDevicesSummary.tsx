import { InfoIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useReportingInstallationsQuery,
  type InsightsOverviewInput,
} from "@/lib/insights-api";

export function ReportingDevicesSummary({
  scope,
}: {
  readonly scope: Omit<InsightsOverviewInput, "window" | "bundleId">;
}) {
  const query = useReportingInstallationsQuery({ ...scope, window: "30d" });
  const infoId = useId();
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <Card
      aria-label="Monthly active users over 30 days"
      className="flex items-center justify-between"
      role="region"
    >
      <CardHeader className="min-w-0 gap-2 p-6 sm:px-8">
        <CardTitle className="flex items-center gap-1 text-sm font-medium">
          <span className="whitespace-nowrap">MAU · 30d</span>
          <Tooltip
            open={infoOpen}
            onOpenChange={setInfoOpen}
            triggerId={infoId}
          >
            <TooltipTrigger
              id={infoId}
              aria-describedby={infoOpen ? `${infoId}-description` : undefined}
              closeOnClick={false}
              onClick={() => setInfoOpen((open) => !open)}
              render={
                <Button
                  aria-label="How MAU is counted"
                  className="size-11 sm:size-7"
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <InfoIcon />
            </TooltipTrigger>
            <TooltipContent
              className="max-w-64"
              id={`${infoId}-description`}
              role="tooltip"
              side="bottom"
            >
              Unique app installations that reported activity in the last 30
              days, including no-change reports. Filtered by platform and
              channel.
            </TooltipContent>
          </Tooltip>
        </CardTitle>
      </CardHeader>
      <CardContent className="shrink-0 p-6 sm:px-8">
        {query.isPending ? (
          <Skeleton
            aria-label="Loading monthly active users"
            className="h-9 w-12"
          />
        ) : query.error ? (
          <div className="flex flex-col items-end gap-2">
            <span className="text-xs text-muted-foreground">Unavailable</span>
            <Button
              aria-label="Retry monthly active user count"
              onClick={() => void query.refetch()}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : (
          <p className="text-4xl font-semibold tabular-nums">
            {query.data?.reportingInstallations.count.toLocaleString() ?? "—"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
