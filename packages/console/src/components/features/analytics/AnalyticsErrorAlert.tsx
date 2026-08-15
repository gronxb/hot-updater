import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getAnalyticsErrorCopy } from "@/lib/analytics-error";

export function AnalyticsErrorAlert({
  error,
  fallbackTitle,
}: {
  readonly error: Error;
  readonly fallbackTitle: string;
}) {
  const copy = getAnalyticsErrorCopy(error, fallbackTitle);
  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.description}</AlertDescription>
    </Alert>
  );
}
