import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsOverview as AnalyticsOverviewData } from "@/lib/analytics-overview";

import { AdoptionChart } from "./AdoptionChart";
import { RolloutList } from "./RolloutList";

type AnalyticsOverviewProps =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: Error }
  | { readonly status: "success"; readonly data: AnalyticsOverviewData };

const percentage = (share: number): string =>
  new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(share);

export function AnalyticsOverview(props: AnalyticsOverviewProps) {
  if (props.status === "loading") {
    return (
      <div
        aria-label="Loading analytics overview"
        className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.8fr)]"
      >
        <Skeleton className="h-96 w-full" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      </div>
    );
  }

  if (props.status === "error") {
    return (
      <Alert variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Analytics overview unavailable</AlertTitle>
        <AlertDescription>{props.error.message}</AlertDescription>
      </Alert>
    );
  }

  const { data } = props;
  const hasTrackedInstallations = data.trackedInstallations > 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.8fr)]">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Observed bundle adoption
          </CardTitle>
          <CardDescription>
            Latest reported bundle event for each tracked installation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasTrackedInstallations ? (
            <AdoptionChart adoption={data.adoption} />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No tracked installation reports are available yet.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Tracked overview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-4">
              <div className="flex items-end justify-between gap-4">
                <dt className="text-sm text-muted-foreground">
                  Tracked installations
                </dt>
                <dd className="text-3xl font-semibold tracking-tight tabular-nums">
                  {data.trackedInstallations.toLocaleString()}
                </dd>
              </div>
              {data.mostActiveBundle ? (
                <div className="flex flex-col gap-1 border-t pt-4">
                  <dt className="text-xs text-muted-foreground">
                    Most active observed bundle
                  </dt>
                  <dd className="flex flex-col gap-1">
                    <code className="break-all text-xs">
                      {data.mostActiveBundle.bundleId}
                    </code>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {data.mostActiveBundle.trackedInstallations.toLocaleString()}{" "}
                      tracked ·{" "}
                      {percentage(data.mostActiveBundle.observedShare)}
                    </span>
                  </dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Configured rollout
            </CardTitle>
            <CardDescription>
              Eligibility configuration with observed tracked counts.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RolloutList rollouts={data.configuredRollouts} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
