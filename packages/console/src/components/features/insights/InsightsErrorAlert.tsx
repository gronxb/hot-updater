import { Info, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isConsoleFeatureUnavailableError } from "@/lib/console-features";

export function InsightsErrorAlert({
  error,
  fallbackTitle,
}: {
  readonly error: Error;
  readonly fallbackTitle: string;
}) {
  // A server restarted without insights() refuses the reads of a page opened
  // before: that is its setup, not a failure.
  if (isConsoleFeatureUnavailableError(error)) {
    return (
      <Alert>
        <Info aria-hidden="true" />
        <AlertTitle>Insights not installed</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{fallbackTitle}</AlertTitle>
      <AlertDescription>
        Refresh to try again. If this keeps happening, check your Insights
        provider connection.
      </AlertDescription>
    </Alert>
  );
}
