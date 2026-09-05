import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReportingInstallations } from "@/lib/insights-api";
import { outcomeLabels } from "@/lib/insights-view";

import { EventTimestamp, useInsightsTimeFormat } from "./EventDetails";
import type { InsightsReportSelection } from "./InsightsBundleReports";
import { InsightsErrorAlert } from "./InsightsErrorAlert";

type InsightsOverviewProps =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: Error }
  | {
      readonly status: "success";
      readonly active: ReportingInstallations;
      readonly onOutcomeSelect: (selection: InsightsReportSelection) => void;
    };

const windowCopy = {
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
} as const;

export function InsightsOverview(props: InsightsOverviewProps) {
  const dateTimeFormat = useInsightsTimeFormat();

  if (props.status === "loading") {
    return (
      <Card aria-label="Loading reporting installations" className="shadow-sm">
        <CardHeader className="px-4 pt-4 pb-2 sm:px-6 sm:pt-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-full max-w-md" />
        </CardHeader>
        <CardContent className="px-4 pb-6 sm:px-6">
          <Skeleton className="h-12 w-28" />
        </CardContent>
        <CardFooter className="border-t px-4 py-3 sm:px-6">
          <Skeleton className="h-8 w-full max-w-sm" />
        </CardFooter>
      </Card>
    );
  }

  if (props.status === "error") {
    return (
      <InsightsErrorAlert
        error={props.error}
        fallbackTitle="Reporting installations unavailable"
      />
    );
  }

  const { active } = props;
  const bundle = active.bundle;

  return (
    <section
      aria-labelledby="reporting-installations-heading"
      className="flex flex-col gap-4"
    >
      <Card className="min-w-0 overflow-hidden shadow-sm">
        <CardHeader className="gap-2 px-4 pt-4 pb-2 sm:px-6 sm:pt-6">
          <CardTitle className="text-sm font-medium">
            <h2 id="reporting-installations-heading">
              Reporting installations
            </h2>
          </CardTitle>
          <CardDescription>
            {active.platform === "ios" ? "iOS" : "Android"} · {active.channel} ·{" "}
            {windowCopy[active.window]}. Installations are counted by their last
            report received.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pt-2 pb-5 sm:px-6 sm:pb-6">
          <p className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
            {active.reportingInstallations.count.toLocaleString()}
          </p>
        </CardContent>
        <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/15 px-4 py-3 sm:px-6">
          <dl className="min-w-0 text-xs">
            <dt className="text-muted-foreground">Measured at</dt>
            <dd className="font-medium tabular-nums">
              <EventTimestamp
                formatter={dateTimeFormat}
                touch
                value={active.reportingInstallations.measuredAtMs}
              />
            </dd>
          </dl>
          <Link
            className={buttonVariants({
              className: "h-11 px-3 lg:h-8",
              variant: "outline",
            })}
            to="/installations"
          >
            View events
            <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
          </Link>
        </CardFooter>
      </Card>
      {bundle ? (
        <Card className="min-w-0 overflow-hidden shadow-sm">
          <CardHeader>
            <CardTitle>Selected bundle</CardTitle>
            <CardDescription className="break-all">
              {bundle.bundleId}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <dt className="text-sm">Selected bundle installations</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">
                    {bundle.reportingInstallations.count.toLocaleString()}
                  </dd>
                </div>
                <div className="text-xs text-muted-foreground">
                  Measured at{" "}
                  <EventTimestamp
                    formatter={dateTimeFormat}
                    touch
                    value={bundle.reportingInstallations.measuredAtMs}
                  />
                </div>
              </div>
              {(
                [
                  ["applied", bundle.appliedReports],
                  ["recovered", bundle.recoveredReports],
                  ["adopted", bundle.adoptedReports],
                ] as const
              ).map(([outcome, measurement]) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3"
                  key={outcome}
                >
                  <div>
                    <dt className="text-sm">{outcomeLabels[outcome]}</dt>
                    <dd className="mt-1 text-2xl font-semibold tabular-nums">
                      {measurement.count.toLocaleString()}
                    </dd>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Measured at{" "}
                      <EventTimestamp
                        formatter={dateTimeFormat}
                        touch
                        value={measurement.measuredAtMs}
                      />
                    </div>
                  </div>
                  <Button
                    className="h-11 lg:h-8"
                    variant="outline"
                    onClick={() =>
                      props.onOutcomeSelect({
                        bundle: {
                          platform: active.platform,
                          channel: active.channel,
                          bundleId: bundle.bundleId,
                          outcome,
                        },
                        sinceMs: active.sinceMs,
                        beforeReceivedAtMs: active.beforeReceivedAtMs,
                      })
                    }
                  >
                    View {outcome} reports
                    <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
                  </Button>
                </div>
              ))}
            </dl>
          </CardContent>
          <CardFooter>
            <p className="text-xs text-muted-foreground">
              Installation counts are independent live measurements. Outcome
              counts are accepted reports, not unique devices or update
              attempts. Recovery reports identify the bundle recovered from.
            </p>
          </CardFooter>
        </Card>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Offline installations, opt-outs, and reports that did not reach the
        server are absent.
      </p>
    </section>
  );
}
