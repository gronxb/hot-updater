import { Link } from "@tanstack/react-router";
import { ChartLine } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  BundleActivityInput,
  BundleActivityReport,
} from "@/lib/bundle-activity";
import { useBundleActivityQuery } from "@/lib/bundle-activity";
import { useConsoleFeature } from "@/lib/console-features-api";
import { useUpdateFailuresQuery } from "@/lib/insights-api";
import { failureRate, formatRate } from "@/lib/insights-failures";
import { adoptionWindow } from "@/lib/insights-search";
import { cn } from "@/lib/utils";

import type { ReleaseColumn } from "../FeatureSlots";
import { InsightsInfo } from "./InsightsInfo";

const activityStats = [
  { label: "Downloads", field: "downloads", color: "text-primary/85" },
  { label: "Active days", field: "activeDays", color: "text-success/85" },
  { label: "Known crashes", field: "failedLaunches", color: "text-warning/85" },
] as const;

const crashRate = (report: BundleActivityReport): string => {
  const attempts = report.activeDays + report.failedLaunches;
  return attempts === 0
    ? "—"
    : `${((report.failedLaunches / attempts) * 100).toFixed(2)}%`;
};

function ReleaseMetricsInfo() {
  return (
    <InsightsInfo label="About release insight metrics">
      Active days count each installation once for each UTC day it launched this
      release. Known crashes are reported OTA launch failures that triggered
      recovery. The rate is known crashes divided by active days plus known
      crashes.
    </InsightsInfo>
  );
}

export function BundleMovementSummary({
  report,
  loading = false,
  input,
  variant = "inline",
}: {
  readonly report?: BundleActivityReport;
  readonly loading?: boolean;
  readonly input?: BundleActivityInput;
  readonly variant?: "inline" | "card";
}) {
  if (!report) {
    return loading ? (
      <Skeleton
        aria-label="Loading release insights"
        className={variant === "card" ? "h-16 w-full" : "h-4 w-40"}
      />
    ) : (
      <span
        aria-label="Release insights unavailable"
        className="text-sm text-muted-foreground"
      >
        —
      </span>
    );
  }
  const metrics = (
    <dl
      className={cn(
        variant === "card"
          ? "grid grid-cols-[1fr_1fr_auto] gap-4"
          : "flex min-w-[220px] flex-wrap items-baseline gap-x-3 gap-y-1",
      )}
    >
      {activityStats.map(({ label, field, color }) => (
        <div
          key={field}
          className={cn(
            "flex",
            variant === "card"
              ? "min-w-0 flex-col gap-1"
              : "items-baseline gap-1.5 whitespace-nowrap",
          )}
        >
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd
            className={cn(
              "flex flex-wrap items-baseline gap-x-1.5 tabular-nums",
              variant === "card"
                ? "text-xl font-semibold"
                : "text-sm font-medium",
              report[field] > 0 ? color : "text-muted-foreground",
            )}
          >
            {report[field].toLocaleString()}
            {field === "failedLaunches" ? (
              <span className="text-xs font-normal text-muted-foreground">
                ({crashRate(report)})
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
  return (
    <div
      className={cn(
        "flex",
        variant === "card" ? "flex-col gap-2" : "items-center gap-1",
      )}
    >
      {input ? (
        <Link
          className="min-w-0 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      {variant === "inline" ? <ReleaseMetricsInfo /> : null}
    </div>
  );
}

/** The release's failed downloads and installs since its first report, and their rate. */
export function BundleDownloadFailures({
  input,
}: {
  readonly input: BundleActivityInput;
}) {
  const query = useUpdateFailuresQuery({
    platform: input.platform,
    channel: input.channel,
    releaseId: input.releaseId,
  });
  const report = query.data;
  return (
    <div className="flex items-center gap-1">
      {report ? (
        <dl>
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <dt className="text-xs text-muted-foreground">Download failures</dt>
            <dd
              className={cn(
                "flex items-baseline gap-1.5 text-sm font-medium tabular-nums",
                report.failedUpdates > 0
                  ? "text-warning/85"
                  : "text-muted-foreground",
              )}
            >
              {report.failedUpdates.toLocaleString()}
              <span className="text-xs font-normal text-muted-foreground">
                ({formatRate(failureRate(report))})
              </span>
            </dd>
          </div>
        </dl>
      ) : query.isPending ? (
        <Skeleton aria-label="Loading download failures" className="h-4 w-40" />
      ) : (
        <span
          aria-label="Download failures unavailable"
          className="text-sm text-muted-foreground"
        >
          —
        </span>
      )}
      <InsightsInfo label="About download failures">
        Reported failures to download or install this release, since its first
        report; each client reports one at most once a UTC day. The rate is the
        failure rate of update attempts: failures divided by failures plus
        download reports.
      </InsightsInfo>
    </div>
  );
}

/** The bundle detail's Insights card, a section of the release editor: activity and download failures. */
export function BundleInsightsSummary({
  input,
}: {
  readonly input: BundleActivityInput;
}) {
  const query = useBundleActivityQuery([input]);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between px-4 pt-4 pb-3">
        <CardTitle className="text-sm font-medium">Insights</CardTitle>
        <ReleaseMetricsInfo />
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 pb-4">
        <BundleMovementSummary
          variant="card"
          input={input}
          loading={query.isFetching}
          report={query.data?.[input.releaseId]}
        />
        <Separator />
        <BundleDownloadFailures input={input} />
      </CardContent>
      <CardFooter className="px-4 pb-4">
        <Link
          className={buttonVariants({ variant: "outline", size: "sm" })}
          to="/insights"
          search={{
            healthPlatform: input.platform,
            healthChannel: input.channel,
            releaseId: input.releaseId,
            bundleWindow: adoptionWindow(input.releaseId),
            healthChart: "adoption",
          }}
        >
          <ChartLine aria-hidden="true" data-icon="inline-start" />
          View adoption
        </Link>
      </CardFooter>
    </Card>
  );
}

/**
 * The release editor's Insights card where the console reads no release
 * activity, as through a self-hosted server's admin API: download failures
 * alone. With release activity, its card shows them.
 */
export function ReleaseFailuresSection({
  input,
}: {
  readonly input: BundleActivityInput;
}) {
  const activity = useConsoleFeature("insightsAnalytics");
  if (activity) return null;
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-3">
        <CardTitle className="text-sm font-medium">Insights</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <BundleDownloadFailures input={input} />
      </CardContent>
    </Card>
  );
}

/**
 * One release's activity in the Bundles page's Insights column. Every cell
 * asks for the page's releases under one query key, so the page makes one
 * request.
 */
function ReleaseActivityCell({
  releaseId,
  releases,
}: {
  readonly releaseId: string;
  readonly releases: readonly BundleActivityInput[];
}) {
  const query = useBundleActivityQuery(releases);
  return (
    <BundleMovementSummary
      input={releases.find((release) => release.releaseId === releaseId)}
      loading={query.isFetching}
      report={query.data?.[releaseId]}
    />
  );
}

/** The Bundles page's Insights column: each release's downloads, active days, and crashes. */
export const releaseActivityColumn: ReleaseColumn = {
  Cell: ReleaseActivityCell,
};
