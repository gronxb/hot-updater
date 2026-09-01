import type { InsightsReadFailure } from "@hot-updater/plugin-core";
import { Clock3, RefreshCw, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import { formatInsightsTimestamp, useInsightsTimeFormat } from "./EventDetails";

const failureCopy = (failure: InsightsReadFailure) => {
  switch (failure.code) {
    case "schema-not-ready":
    case "storage-not-ready":
    case "index-not-ready":
    case "source-not-ready":
      return "Insights storage is not ready yet. Finish the database preparation, then retry.";
    case "preparation-failed":
      return "The exact report could not be prepared. Check the Insights maintenance worker, then retry.";
    case "migration-poison":
      return "Insights preparation found an event that cannot be migrated safely. The source event was left unchanged.";
    case "storage-corruption":
      return "Insights detected inconsistent stored identities and stopped before returning incorrect results.";
  }
};

export function InsightsPreparingState({
  label = "Preparing exact results",
}: {
  readonly label?: string;
}) {
  return (
    <Alert>
      <Clock3 aria-hidden="true" />
      <AlertTitle>{label}</AlertTitle>
      <AlertDescription>
        This view will update when the durable preparation job finishes.
      </AlertDescription>
    </Alert>
  );
}

export function InsightsStaleNotice({ asOfMs }: { readonly asOfMs: number }) {
  const formatter = useInsightsTimeFormat();
  return (
    <Alert>
      <RefreshCw aria-hidden="true" />
      <AlertTitle>Refreshing exact results</AlertTitle>
      <AlertDescription>
        Showing the last complete report from{" "}
        {formatInsightsTimestamp(asOfMs, formatter)}.
      </AlertDescription>
    </Alert>
  );
}

export function InsightsFailedState({
  failure,
}: {
  readonly failure: InsightsReadFailure;
}) {
  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Insights need attention</AlertTitle>
      <AlertDescription>{failureCopy(failure)}</AlertDescription>
    </Alert>
  );
}

export function InsightsExpiredState({
  onRestart,
}: {
  readonly onRestart: () => void;
}) {
  return (
    <Alert>
      <RefreshCw aria-hidden="true" />
      <AlertTitle>This result has expired</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        Start a new view to use one consistent publication.
        <Button
          className="h-11 lg:h-8"
          onClick={onRestart}
          type="button"
          variant="outline"
        >
          Start again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
