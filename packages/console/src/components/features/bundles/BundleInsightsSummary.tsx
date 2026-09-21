import { Link } from "@tanstack/react-router";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  BundleActivityInput,
  BundleActivityReport,
} from "@/lib/bundle-activity";
import { useBundleActivityQuery } from "@/lib/bundle-activity";

import { InsightsInfo } from "../insights/InsightsInfo";

const crashRate = (report: BundleActivityReport): string => {
  const attempts = report.launches + report.failedLaunches;
  return attempts === 0
    ? "—"
    : `${((report.failedLaunches / attempts) * 100).toFixed(2)}%`;
};

export function BundleMovementSummary({
  report,
  loading = false,
  input,
}: {
  readonly report?: BundleActivityReport;
  readonly loading?: boolean;
  readonly input?: BundleActivityInput;
}) {
  if (!report) {
    return loading ? (
      <Skeleton aria-label="Loading release insights" className="h-4 w-40" />
    ) : (
      <span aria-label="Release insights unavailable">—</span>
    );
  }
  const metrics = (
    <span className="flex min-w-[220px] flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span>Downloads {report.downloads.toLocaleString()}</span>
      <span>Known launches {report.launches.toLocaleString()}</span>
      <span>
        Known crashes {report.failedLaunches.toLocaleString()} (
        {crashRate(report)})
      </span>
      {report.coverage.kind === "partial" ? (
        <span className="text-xs text-muted-foreground">Partial</span>
      ) : null}
    </span>
  );
  return (
    <span className="flex items-center gap-1">
      {input ? (
        <Link
          className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          to="/insights"
          search={{
            healthPlatform: input.platform,
            healthChannel: input.channel,
            releaseId: input.releaseId,
            bundleWindow: "7d",
          }}
        >
          {metrics}
        </Link>
      ) : (
        metrics
      )}
      <InsightsInfo label="About release insight metrics">
        Known crashes are reported OTA launch failures that triggered recovery.
        The rate is known crashes divided by known launches plus known crashes.
      </InsightsInfo>
    </span>
  );
}

export function BundleInsightsSummary({
  input,
}: {
  readonly input: BundleActivityInput;
}) {
  const query = useBundleActivityQuery([input]);
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-3">
        <CardTitle className="text-sm font-medium">Insights</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <BundleMovementSummary
          input={input}
          loading={query.isFetching}
          report={query.data?.[input.releaseId]}
        />
      </CardContent>
    </Card>
  );
}
