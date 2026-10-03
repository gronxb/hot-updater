/** How long the server's `insights()` keeps rows, in days. */
export interface InsightsRetentionDays {
  /** Raw events and hourly totals. */
  readonly rawDays: number;
  /** Daily totals, distributions, and each installation's latest report. */
  readonly dailyDays: number;
}

/** `insights()`'s defaults, for a server that does not report its periods. */
export const DEFAULT_INSIGHTS_RETENTION: InsightsRetentionDays = {
  rawDays: 90,
  dailyDays: 400,
};

export const formatDays = (days: number): string =>
  `${days.toLocaleString("en")} ${days === 1 ? "day" : "days"}`;

/** Whether daily totals cover App usage's 12-month period: 52 weeks. */
export const keepsTwelveMonths = ({
  dailyDays,
}: InsightsRetentionDays): boolean => dailyDays >= 364;
