import type { ActiveInstallationOverview } from "@hot-updater/analytics";
import type { ReactNode } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsOverview as CatalogOverview } from "@/lib/analytics-overview";
import { cn } from "@/lib/utils";

import { ActivityChart } from "./ActivityChart";
import { AnalyticsErrorAlert } from "./AnalyticsErrorAlert";
import { BundleSelector } from "./BundleSelector";
import { UpdateOutcomes, type UpdateOutcomeState } from "./UpdateOutcomes";

type AnalyticsOverviewProps =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: Error }
  | {
      readonly status: "success";
      readonly active: ActiveInstallationOverview;
      readonly bundleId: string;
      readonly bundles: readonly {
        readonly bundleId: string;
        readonly description: string;
      }[];
      readonly catalog: CatalogOverview;
      readonly onBundleChange: (bundleId: string) => void;
      readonly outcomes: UpdateOutcomeState;
    };

const asOfFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const activityWindowCopy = {
  "24h": {
    label: "Daily active installations",
    period: "last 24 hours",
  },
  "7d": {
    label: "Weekly active installations",
    period: "last 7 days",
  },
  "30d": {
    label: "Monthly active installations",
    period: "last 30 days",
  },
} as const;

function LoadingCard({
  children,
  className,
  label,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly label: string;
}) {
  return (
    <Card aria-label={label} className={cn("min-w-0", className)}>
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
        aria-label="Loading reporting analytics"
        className="flex min-w-0 flex-col gap-8"
      >
        <LoadingCard label="Loading installation activity">
          <Skeleton className="h-10 w-24" />
          <Skeleton className="mt-5 h-64 w-full" />
          <div className="mt-5 grid gap-4 border-t pt-5 sm:grid-cols-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </LoadingCard>
        <LoadingCard label="Loading bundle detail">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-10 w-full max-w-md" />
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
            <Skeleton className="h-32 w-full" />
          </div>
        </LoadingCard>
      </div>
    );
  }

  if (props.status === "error") {
    return (
      <AnalyticsErrorAlert
        error={props.error}
        fallbackTitle="Reporting analytics unavailable"
      />
    );
  }

  const { active, bundleId, bundles, catalog, onBundleChange, outcomes } =
    props;
  const activityCopy = activityWindowCopy[active.window];
  const selectedBundleId =
    outcomes.status === "idle" ? null : outcomes.bundleId;
  const latestBundleInstallations =
    active.bundles.find(({ bundleId }) => bundleId === selectedBundleId)
      ?.installations ?? 0;
  const configuredPercentage =
    catalog.configuredRollouts.find(
      ({ bundleId }) => bundleId === selectedBundleId,
    )?.configuredPercentage ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <section aria-label="Installation activity">
        <Card className="min-w-0 overflow-hidden shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-sm font-medium">
              <h2>{activityCopy.label}</h2>
            </CardTitle>
            <CardDescription>
              Unique app installations that reported an update status in the{" "}
              {activityCopy.period}.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">
                Active installations
              </p>
              <div className="flex items-end gap-2">
                <span className="text-4xl font-semibold tracking-tight tabular-nums">
                  {active.activeInstallations.toLocaleString()}
                </span>
                <span className="pb-1 text-xs text-muted-foreground">
                  unique in {activityCopy.period}
                </span>
              </div>
            </div>
            <div className="border-t pt-5">
              <ActivityChart series={active.series} window={active.window} />
            </div>
          </CardContent>
          <CardFooter className="border-t bg-muted/15 p-0">
            <dl className="grid w-full sm:grid-cols-3 sm:divide-x sm:divide-border/70">
              <div className="flex flex-col gap-1 px-5 py-4">
                <dt className="text-xs text-muted-foreground">
                  Reported bundles
                </dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {active.bundles.length.toLocaleString()}
                </dd>
              </div>
              <div className="flex flex-col gap-1 border-t px-5 py-4 sm:border-t-0">
                <dt className="text-xs text-muted-foreground">
                  Reporting window
                </dt>
                <dd className="text-sm font-medium">{activityCopy.period}</dd>
              </div>
              <div className="flex flex-col gap-1 border-t px-5 py-4 sm:border-t-0">
                <dt className="text-xs text-muted-foreground">As of</dt>
                <dd className="text-xs font-medium tabular-nums">
                  {asOfFormatter.format(new Date(active.asOfMs))} UTC
                </dd>
              </div>
            </dl>
          </CardFooter>
        </Card>
      </section>

      <section aria-labelledby="bundle-detail-heading">
        <UpdateOutcomes
          bundleSelector={
            <BundleSelector
              bundleId={bundleId}
              bundles={bundles}
              onBundleChange={onBundleChange}
            />
          }
          configuredPercentage={configuredPercentage}
          latestBundleInstallations={latestBundleInstallations}
          reportingInstallations={active.activeInstallations}
          state={outcomes}
          window={active.window}
        />
      </section>
    </div>
  );
}
