import type {
  InsightsActiveWindow,
  InsightsSeriesRow,
} from "@hot-updater/plugin-core";
import type { ReactNode } from "react";

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { ActivityChart } from "./ActivityChart";
import { EventTimestamp, useInsightsTimeFormat } from "./EventDetails";
import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { UpdateOutcomes, type UpdateOutcomeState } from "./UpdateOutcomes";

type InsightsOverviewProps =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: Error }
  | {
      readonly status: "success";
      readonly active: {
        readonly activeInstallations: number;
        readonly asOfMs: number;
        readonly reportedBundles: number | null;
        readonly series: readonly InsightsSeriesRow[];
        readonly window: InsightsActiveWindow;
      };
      readonly bundleSelector: ReactNode;
      readonly configuredPercentage: number | null;
      readonly latestBundleInstallations: number;
      readonly outcomes: UpdateOutcomeState;
      readonly trackedInstallations: number;
    };

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

export function InsightsOverview(props: InsightsOverviewProps) {
  const dateTimeFormat = useInsightsTimeFormat();
  if (props.status === "loading") {
    return (
      <div
        aria-label="Loading reporting insights"
        className="flex min-w-0 flex-col gap-4 sm:gap-6"
      >
        <LoadingCard label="Loading installation activity">
          <Skeleton className="h-10 w-24" />
          <Skeleton className="mt-4 h-40 w-full sm:h-56" />
          <div className="mt-4 grid grid-cols-2 gap-4 border-t pt-4">
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
      <InsightsErrorAlert
        error={props.error}
        fallbackTitle="Reporting insights unavailable"
      />
    );
  }

  const {
    active,
    bundleSelector,
    configuredPercentage,
    latestBundleInstallations,
    outcomes,
    trackedInstallations,
  } = props;
  const activityCopy = activityWindowCopy[active.window];

  return (
    <div className="flex min-w-0 flex-col gap-4 sm:gap-6">
      <section aria-label="Installation activity">
        <Card className="min-w-0 overflow-hidden shadow-sm">
          <CardHeader className="px-4 pt-4 pb-2 sm:px-6 sm:pt-6">
            <CardTitle className="text-sm font-medium">
              <h2>{activityCopy.label}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 px-4 pb-4 sm:px-6 sm:pb-6">
            <p className="text-4xl font-semibold tracking-tight tabular-nums">
              {active.activeInstallations.toLocaleString()}
              <span className="sr-only">
                {` unique installations that reported activity or an update in the ${activityCopy.period}`}
              </span>
            </p>
            <ActivityChart series={active.series} window={active.window} />
          </CardContent>
          <CardFooter className="border-t bg-muted/15 p-0">
            <dl className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-6 px-4 py-3 sm:px-6">
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">
                  Tracked bundles
                </dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {active.reportedBundles === null
                    ? "—"
                    : active.reportedBundles.toLocaleString()}
                </dd>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <dt className="text-xs text-muted-foreground">As of</dt>
                <dd className="text-xs font-medium tabular-nums">
                  <EventTimestamp
                    touch
                    value={active.asOfMs}
                    formatter={dateTimeFormat}
                  />
                </dd>
              </div>
            </dl>
          </CardFooter>
        </Card>
      </section>

      <section aria-labelledby="bundle-detail-heading">
        <UpdateOutcomes
          bundleSelector={bundleSelector}
          configuredPercentage={configuredPercentage}
          latestBundleInstallations={latestBundleInstallations}
          reportingInstallations={trackedInstallations}
          state={outcomes}
          window={active.window}
        />
      </section>
    </div>
  );
}
