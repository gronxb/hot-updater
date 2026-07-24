import type { ActiveInstallationWindow } from "@hot-updater/analytics";
import type { ReactNode } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { BundleEventAnalytics } from "@/lib/api";

import { BundleActivityChart } from "../bundles/BundleActivityChart";
import { AnalyticsErrorAlert } from "./AnalyticsErrorAlert";

export type UpdateOutcomeState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly bundleId: string }
  | {
      readonly status: "error";
      readonly bundleId: string;
      readonly error: Error;
    }
  | {
      readonly status: "success";
      readonly bundleId: string;
      readonly data: BundleEventAnalytics;
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
  readonly window: ActiveInstallationWindow;
}) {
  const latestBundleShare =
    reportingInstallations === 0
      ? 0
      : (latestBundleInstallations / reportingInstallations) * 100;

  return (
    <Card className="min-w-0 overflow-hidden shadow-sm">
      <CardHeader className="gap-4 space-y-0 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <CardTitle className="text-sm font-medium">
            <h2 id="bundle-detail-heading">Selected bundle activity</h2>
          </CardTitle>
          <CardDescription>
            Select a bundle to inspect its latest presence, applies, and
            recoveries during this period.
          </CardDescription>
        </div>
        {bundleSelector}
      </CardHeader>
      <CardContent className="pt-10">
        {state.status === "idle" ? (
          <p className="text-sm text-muted-foreground">
            No active bundle is available.
          </p>
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
        ) : state.status === "error" ? (
          <AnalyticsErrorAlert
            error={state.error}
            fallbackTitle="Bundle movement unavailable"
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-5">
            <dl className="grid sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-border/70">
              <div className="border-b pb-4 sm:pr-4 lg:border-b-0">
                <dt className="text-xs text-muted-foreground">
                  Latest bundle share
                </dt>
                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {Math.round(latestBundleShare)}%
                </dd>
                <dd className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {latestBundleInstallations.toLocaleString()} of{" "}
                  {reportingInstallations.toLocaleString()} reporting installs
                </dd>
              </div>
              <div className="border-b py-4 sm:pl-4 lg:border-b-0 lg:py-0 lg:pr-4">
                <dt className="text-xs text-muted-foreground">Newly applied</dt>
                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {state.data.summary.installed.toLocaleString()}
                </dd>
                <dd className="mt-1 text-xs text-muted-foreground">
                  Distinct installations
                </dd>
              </div>
              <div className="border-b py-4 sm:pr-4 lg:border-b-0 lg:py-0 lg:pl-4">
                <dt className="text-xs text-muted-foreground">
                  Recovered away
                </dt>
                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {state.data.summary.recovered.toLocaleString()}
                </dd>
                <dd className="mt-1 text-xs text-muted-foreground">
                  Distinct installations
                </dd>
              </div>
              <div className="pt-4 sm:pl-4 lg:py-0">
                <dt className="text-xs text-muted-foreground">
                  Configured rollout
                </dt>
                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {configuredPercentage === null
                    ? "—"
                    : `${configuredPercentage}%`}
                </dd>
                <dd className="mt-1 text-xs text-muted-foreground">
                  Eligibility setting
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
