import { useState } from "react";

import { InsightsErrorAlert } from "@/components/features/insights/InsightsErrorAlert";
import {
  InsightsExpiredState,
  InsightsFailedState,
  InsightsPreparingState,
  InsightsStaleNotice,
} from "@/components/features/insights/InsightsReadState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useInsightsReportPageQuery,
  useInsightsReportQuery,
} from "@/lib/insights-api";

import { BundleActivityChart } from "./BundleActivityChart";

interface BundleInsightsSummaryProps {
  readonly bundleId: string;
}

function Metric({
  label,
  tone,
  value,
}: {
  readonly label: string;
  readonly tone: "applied" | "recovered";
  readonly value: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className={
            tone === "applied"
              ? "size-2 rounded-full bg-chart-2"
              : "size-2 rounded-full bg-muted-foreground"
          }
        />
        {label}
      </dt>
      <dd className="text-xl font-semibold tracking-tight tabular-nums">
        {value}
      </dd>
    </div>
  );
}

export function BundleInsightsSummary({
  bundleId,
}: BundleInsightsSummaryProps) {
  const [minAsOfMs, setMinAsOfMs] = useState<number>();
  const report = useInsightsReportQuery({
    query: { bundleId, kind: "bundleDetail", window: "30d" },
    ...(minAsOfMs === undefined ? {} : { minAsOfMs }),
  });
  const read = report.data;
  const publication =
    (read?.state === "ready" || read?.state === "stale") &&
    read.data.kind === "bundleDetail"
      ? read.data
      : undefined;
  const installed = useInsightsReportPageQuery(
    {
      limit: 100,
      metric: "installed",
      publicationId: publication?.id ?? "",
      section: "movementSeries",
    },
    publication !== undefined,
  );
  const recovered = useInsightsReportPageQuery(
    {
      limit: 100,
      metric: "recovered",
      publicationId: publication?.id ?? "",
      section: "movementSeries",
    },
    publication !== undefined,
  );
  const installedRead = installed.data;
  const recoveredRead = recovered.data;
  const installedSeries =
    installedRead?.state === "ready" &&
    installedRead.data.section === "movementSeries" &&
    installedRead.data.metric === "installed"
      ? installedRead.data.data
      : undefined;
  const recoveredSeries =
    recoveredRead?.state === "ready" &&
    recoveredRead.data.section === "movementSeries" &&
    recoveredRead.data.metric === "recovered"
      ? recoveredRead.data.data
      : undefined;
  const failure =
    read?.state === "failed"
      ? read.error
      : installedRead?.state === "failed"
        ? installedRead.error
        : recoveredRead?.state === "failed"
          ? recoveredRead.error
          : undefined;
  const expired =
    installedRead?.state === "expired" || recoveredRead?.state === "expired";
  const loading =
    report.isLoading || installed.isLoading || recovered.isLoading;

  return (
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="text-sm font-medium">
          Activity · 30 days
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 pb-4">
        {report.error ? (
          <InsightsErrorAlert
            error={report.error}
            fallbackTitle="Insights unavailable"
          />
        ) : failure ? (
          <InsightsFailedState failure={failure} />
        ) : expired ? (
          <InsightsExpiredState onRestart={() => setMinAsOfMs(Date.now())} />
        ) : read?.state === "preparing" ? (
          <InsightsPreparingState label="Preparing bundle activity" />
        ) : loading || !publication || !installedSeries || !recoveredSeries ? (
          <div
            aria-label="Loading reported bundle outcomes"
            className="flex flex-col gap-3"
          >
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
            <Skeleton className="h-24 w-full sm:h-32" />
          </div>
        ) : (
          <>
            {read?.state === "stale" ? (
              <InsightsStaleNotice asOfMs={publication.asOfMs} />
            ) : null}
            <dl className="grid grid-cols-2 divide-x divide-border/70">
              <div className="pr-4">
                <Metric
                  label="Applied"
                  tone="applied"
                  value={publication.summary.installed}
                />
              </div>
              <div className="pl-4">
                <Metric
                  label="Recovered"
                  tone="recovered"
                  value={publication.summary.recovered}
                />
              </div>
            </dl>
            <BundleActivityChart
              installed={installedSeries}
              recovered={recoveredSeries}
              window="30d"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
