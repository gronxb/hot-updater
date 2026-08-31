export type InsightsErrorCopy = {
  readonly title: string;
  readonly description: string;
};

export const getInsightsErrorCopy = (
  error: Error,
  fallbackTitle: string,
): InsightsErrorCopy => {
  const match = /^Bundle event scan exceeded (\d+) rows\.$/.exec(error.message);
  if (!match) {
    return {
      title: fallbackTitle,
      description:
        "Refresh to try again. If this keeps happening, check your Insights provider connection.",
    };
  }
  const limit = Number(match[1]);
  return {
    title: "Insights report limit reached",
    description: `This view needs to read more than ${limit.toLocaleString()} events. The data is still stored, but this provider cannot query it at this volume.`,
  };
};
