import type { ActiveInstallationOverview } from "@hot-updater/plugin-core";
import type { ReactNode } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsOverview as CatalogOverview } from "@/lib/analytics-overview";

import { ActivityChart } from "./ActivityChart";
import { AnalyticsErrorAlert } from "./AnalyticsErrorAlert";
import { BundleDistribution } from "./BundleDistribution";
import { RolloutList } from "./RolloutList";
import { UpdateOutcomes, type UpdateOutcomeState } from "./UpdateOutcomes";

type AnalyticsOverviewProps =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: Error }
  | {
      readonly status: "success";
      readonly active: ActiveInstallationOverview;
      readonly catalog: CatalogOverview;
      readonly outcomes: UpdateOutcomeState;
      readonly userId: string | undefined;
    };

const asOfFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function LoadingCard({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <Card aria-label={label} className="min-w-0">
      <CardHeader>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-4/5" />
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function AnalyticsOverview(props: AnalyticsOverviewProps) {
  if (props.status === "loading") {
    return (
      <div
        aria-label="Loading active analytics"
        className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.8fr)]"
      >
        <div className="flex flex-col gap-4">
          <LoadingCard label="Loading active installations">
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
            <Skeleton className="mt-4 h-3 w-2/3" />
          </LoadingCard>
          <LoadingCard label="Loading app-ready activity">
            <Skeleton className="h-48 w-full" />
          </LoadingCard>
          <LoadingCard label="Loading latest reported bundles">
            <div className="flex flex-col gap-3">
              <Skeleton className="h-52 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          </LoadingCard>
        </div>
        <div className="flex flex-col gap-4">
          <LoadingCard label="Loading reported bundle outcomes">
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
              <Skeleton className="h-32 w-full" />
            </div>
          </LoadingCard>
          <LoadingCard label="Loading configured rollout">
            <div className="flex flex-col gap-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          </LoadingCard>
        </div>
      </div>
    );
  }

  if (props.status === "error") {
    return (
      <AnalyticsErrorAlert
        error={props.error}
        fallbackTitle="Active analytics unavailable"
      />
    );
  }

  const { active, catalog, outcomes, userId } = props;
  const leadingBundle = active.bundles[0];

  return (
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.8fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              <h2>Active installations</h2>
            </CardTitle>
            <CardDescription>
              Distinct installation IDs with an app-ready report in this range
              {userId ? " for the exact User ID alias." : "."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:divide-x sm:divide-border/70">
              <div className="flex flex-col gap-1 sm:pr-6">
                <dt className="text-xs text-muted-foreground">Installations</dt>
                <dd className="text-3xl font-semibold tracking-tight tabular-nums">
                  {active.activeInstallations.toLocaleString()}
                </dd>
              </div>
              <div className="flex min-w-0 flex-col gap-1 sm:pl-6">
                <dt className="text-xs text-muted-foreground">
                  Most common latest reported bundle
                </dt>
                <dd className="min-w-0">
                  {leadingBundle ? (
                    <>
                      <code className="block break-all text-xs">
                        {leadingBundle.bundleId}
                      </code>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {leadingBundle.installations.toLocaleString()}{" "}
                        {leadingBundle.installations === 1
                          ? "installation"
                          : "installations"}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">None</span>
                  )}
                </dd>
              </div>
            </dl>
            <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
              As of {asOfFormatter.format(new Date(active.asOfMs))} UTC
            </p>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              <h2>App-ready activity</h2>
            </CardTitle>
            <CardDescription>
              Distinct installation IDs per UTC bucket. Values are not
              cumulative.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityChart series={active.series} window={active.window} />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              <h2>Latest reported bundles</h2>
            </CardTitle>
            <CardDescription>
              One latest in-window app-ready report per active installation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BundleDistribution active={active} catalog={catalog} />
          </CardContent>
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <UpdateOutcomes state={outcomes} />
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              <h2>Configured rollout</h2>
            </CardTitle>
            <CardDescription>
              Availability settings, separate from received-report distribution.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RolloutList
              latestReportedBundles={active.bundles}
              rollouts={catalog.configuredRollouts}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
