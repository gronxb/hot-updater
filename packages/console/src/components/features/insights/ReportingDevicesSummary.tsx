import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
  return (
    <Card
      aria-label="Reporting devices over 30 days"
      className="flex items-center justify-between"
      role="region"
    >
      <CardHeader className="min-w-0 gap-2 p-6 sm:px-8">
        <CardTitle className="text-sm font-medium">
          Reporting devices · 30d
        </CardTitle>
        <CardDescription>
          Installations last seen in this scope within 30 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="shrink-0 p-6 sm:px-8">
        {query.isPending ? (
          <Skeleton
            aria-label="Loading reporting devices"
            className="h-9 w-12"
          />
        ) : query.error ? (
          <div className="flex flex-col items-end gap-2">
            <span className="text-xs text-muted-foreground">Unavailable</span>
            <Button
              aria-label="Retry reporting device count"
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
