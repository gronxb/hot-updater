export type AnalyticsErrorCopy = {
  readonly title: string;
  readonly description: string;
};

export const getAnalyticsErrorCopy = (
  error: Error,
  fallbackTitle: string,
): AnalyticsErrorCopy => {
  const match = /^Bundle event scan exceeded (\d+) rows\.$/.exec(error.message);
  if (!match) {
    return { title: fallbackTitle, description: error.message };
  }
  const limit = Number(match[1]);
  return {
    title: "Analytics report limit reached",
    description: `This query matched more than ${limit.toLocaleString()} reports. Narrow the query or configure a dedicated Analytics service.`,
  };
};
