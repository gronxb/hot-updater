export const DEFAULT_PAGE_LIMIT = 20;
export const DEFAULT_PAGE_OFFSET = 0;

export const DATE_RANGE_PRESETS = [
  { label: "Last 24 hours", hours: 24 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
] as const;

export const DEFAULT_DATE_RANGE_DAYS = 7;
export const ANALYTICS_EVENTS_LIMIT = 1000;
