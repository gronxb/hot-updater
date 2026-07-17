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
import type { BundleEventAnalytics } from "@/lib/api";

import { BundleActivityChart } from "../bundles/BundleActivityChart";

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
  state,
}: {
  readonly state: UpdateOutcomeState;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          <h2>Update outcomes</h2>
        </CardTitle>
        <CardDescription>
          All-time Installed and Recovered reports for the leading bundle.
          Routine app-ready reports are excluded.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.status === "idle" ? (
          <p className="text-sm text-muted-foreground">
            No latest reported bundle is available.
          </p>
        ) : state.status === "loading" ? (
          <div
            aria-label="Loading update outcomes"
            className="flex flex-col gap-4"
          >
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
            <Skeleton className="h-32 w-full" />
          </div>
        ) : state.status === "error" ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Update outcomes unavailable</AlertTitle>
            <AlertDescription>{state.error.message}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            <code className="break-all text-xs text-muted-foreground">
              {state.bundleId}
            </code>
            <dl className="grid grid-cols-2 divide-x divide-border/70">
              <div className="pr-4">
                <dt className="text-xs text-muted-foreground">Installed</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">
                  {state.data.summary.installed.toLocaleString()}
                </dd>
              </div>
              <div className="pl-4">
                <dt className="text-xs text-muted-foreground">Recovered</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">
                  {state.data.summary.recovered.toLocaleString()}
                </dd>
              </div>
            </dl>
            <BundleActivityChart
              installed={state.data.series.installed}
              recovered={state.data.series.recovered}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
