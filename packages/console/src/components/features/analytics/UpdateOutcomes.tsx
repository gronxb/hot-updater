import type { ActiveInstallationWindow } from "@hot-updater/plugin-core";

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
  activeInstallations,
  configuredPercentage,
  observedInstallations,
  state,
  window,
}: {
  readonly activeInstallations: number;
  readonly configuredPercentage: number | null;
  readonly observedInstallations: number;
  readonly state: UpdateOutcomeState;
  readonly window: ActiveInstallationWindow;
}) {
  const observedShare =
    activeInstallations === 0
      ? 0
      : (observedInstallations / activeInstallations) * 100;

  return (
    <Card className="min-w-0 overflow-hidden shadow-sm">
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          <h2>Selected bundle adoption</h2>
        </CardTitle>
        <CardDescription>
          Recent presence and movement for the bundle selected above.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
            <code className="break-all text-xs text-muted-foreground">
              {state.bundleId}
            </code>
            <dl className="grid sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-border/70">
              <div className="border-b pb-4 sm:pr-4 lg:border-b-0">
                <dt className="text-xs text-muted-foreground">
                  Observed adoption
                </dt>
                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {Math.round(observedShare)}%
                </dd>
                <dd className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {observedInstallations.toLocaleString()} of{" "}
                  {activeInstallations.toLocaleString()} seen
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
