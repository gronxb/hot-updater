import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function InsightsErrorAlert({
  fallbackTitle,
}: {
  readonly error: Error;
  readonly fallbackTitle: string;
}) {
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
