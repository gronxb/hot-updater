import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getInsightsErrorCopy } from "@/lib/insights-error";

export function InsightsErrorAlert({
  error,
  fallbackTitle,
}: {
  readonly error: Error;
  readonly fallbackTitle: string;
}) {
  const copy = getInsightsErrorCopy(error, fallbackTitle);
  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.description}</AlertDescription>
    </Alert>
  );
}
