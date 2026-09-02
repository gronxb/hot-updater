import type {
  InsightsActiveWindow,
  InsightsBundleSummary,
  InsightsReadFailure,
  InsightsSeriesRow,
} from "@hot-updater/plugin-core";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import { BundleActivityChart } from "../bundles/BundleActivityChart";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import {
  InsightsExpiredState,
  InsightsFailedState,
  InsightsPreparingState,
  InsightsStaleNotice,
} from "./InsightsReadState";

type OutcomeData = {
  readonly summary: InsightsBundleSummary;
  readonly series: {
    readonly installed: readonly InsightsSeriesRow[];
    readonly recovered: readonly InsightsSeriesRow[];
  };
};

export type UpdateOutcomeState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly bundleId: string }
  | { readonly status: "preparing"; readonly bundleId: string }
  | {
      readonly status: "error";
      readonly bundleId: string;
      readonly error: Error;
    }
  | {
      readonly status: "failed";
      readonly bundleId: string;
      readonly failure: InsightsReadFailure;
    }
  | {
      readonly status: "expired";
      readonly bundleId: string;
      readonly onRestart: () => void;
    }
  | {
      readonly status: "success";
      readonly bundleId: string;
      readonly data: OutcomeData;
      readonly staleAsOfMs?: number;
    };

export function UpdateOutcomes({
  bundleSelector,
  configuredPercentage,
  latestBundleInstallations,
  reportingInstallations,
  state,
  window,
}: {
  readonly bundleSelector: ReactNode;
  readonly configuredPercentage: number | null;
  readonly latestBundleInstallations: number;
  readonly reportingInstallations: number;
  readonly state: UpdateOutcomeState;
  readonly window: InsightsActiveWindow;
}) {
  const latestBundleShare =
    reportingInstallations === 0
      ? 0
      : (latestBundleInstallations / reportingInstallations) * 100;

  return (
    <Card className="min-w-0 overflow-hidden shadow-sm">
      <CardHeader className="gap-3 space-y-0 px-4 pt-4 pb-4 sm:px-6 sm:pt-6 lg:flex-row lg:items-center lg:justify-between">
        <CardTitle className="text-sm font-medium">
          <h2 id="bundle-detail-heading">Selected bundle activity</h2>
        </CardTitle>
        {bundleSelector}
      </CardHeader>
      <CardContent className="px-4 pb-4 sm:px-6 sm:pb-6">
        {state.status === "idle" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">No bundles</p>
            <Link
              className={buttonVariants({
                variant: "outline",
                className: "h-11 px-3 lg:h-8",
              })}
              to="/installations"
            >
              View events
            </Link>
          </div>
        ) : state.status === "loading" ? (
          <div
            aria-label="Loading update outcomes"
            className="flex flex-col gap-4"
          >
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
            <Skeleton className="h-32 w-full" />
          </div>
        ) : state.status === "preparing" ? (
          <InsightsPreparingState label="Preparing bundle activity" />
        ) : state.status === "error" ? (
          <InsightsErrorAlert
            error={state.error}
            fallbackTitle="Bundle movement unavailable"
          />
        ) : state.status === "failed" ? (
          <InsightsFailedState failure={state.failure} />
        ) : state.status === "expired" ? (
          <InsightsExpiredState onRestart={state.onRestart} />
        ) : (
          <div className="flex min-w-0 flex-col gap-5">
            {state.staleAsOfMs === undefined ? null : (
              <InsightsStaleNotice asOfMs={state.staleAsOfMs} />
            )}
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">
                  Latest bundle share
                </dt>
                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {Math.round(latestBundleShare)}
                  <span className="text-xs">%</span>
                </dd>
                <dd className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {latestBundleInstallations.toLocaleString()} /{" "}
                  {reportingInstallations.toLocaleString()} installs
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Newly applied</dt>
                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {state.data.summary.installed.toLocaleString()}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    installs
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Recovered away
                </dt>
                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {state.data.summary.recovered.toLocaleString()}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    installs
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Configured rollout
                </dt>
                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {configuredPercentage === null ? (
                    "—"
                  ) : (
                    <>
                      {configuredPercentage}
                      <span className="text-xs">%</span>
                    </>
                  )}
                </dd>
              </div>
            </dl>
            <BundleActivityChart
              installed={state.data.series.installed}
              recovered={state.data.series.recovered}
              window={window}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
