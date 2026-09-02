export type InsightsErrorCopy = {
  readonly title: string;
  readonly description: string;
};

export const getInsightsErrorCopy = (
  _error: Error,
  fallbackTitle: string,
): InsightsErrorCopy => ({
  title: fallbackTitle,
  description:
    "Refresh to try again. If this keeps happening, check your Insights provider connection.",
});
