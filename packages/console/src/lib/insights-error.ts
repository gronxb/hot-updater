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
    return { title: fallbackTitle, description: error.message };
  }
  const limit = Number(match[1]);
  return {
    title: "Insights report limit reached",
    description: `This query matched more than ${limit.toLocaleString()} reports. Narrow the query and try again.`,
  };
};
