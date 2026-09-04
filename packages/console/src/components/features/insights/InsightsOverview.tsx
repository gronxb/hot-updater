import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReportingInstallations } from "@/lib/insights-api";

import { EventTimestamp, useInsightsTimeFormat } from "./EventDetails";
import { InsightsErrorAlert } from "./InsightsErrorAlert";

type InsightsOverviewProps =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: Error }
  | {
      readonly status: "success";
      readonly active: ReportingInstallations;
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

  return (
    <section aria-labelledby="reporting-installations-heading">
      <Card className="min-w-0 overflow-hidden shadow-sm">
        <CardHeader className="gap-2 px-4 pt-4 pb-2 sm:px-6 sm:pt-6">
          <CardTitle className="text-sm font-medium">
            <h2 id="reporting-installations-heading">
              Reporting installations
            </h2>
          </CardTitle>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Unique installations that reported app activity during{" "}
            {windowCopy[active.window]}.
          </p>
        </CardHeader>
        <CardContent className="px-4 pt-2 pb-5 sm:px-6 sm:pb-6">
          <p className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
            {active.activeInstallations.toLocaleString()}
          </p>
        </CardContent>
        <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/15 px-4 py-3 sm:px-6">
          <dl className="min-w-0 text-xs">
            <dt className="text-muted-foreground">Measured at</dt>
            <dd className="font-medium tabular-nums">
              <EventTimestamp
                formatter={dateTimeFormat}
                touch
                value={active.asOfMs}
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
    </section>
  );
}
