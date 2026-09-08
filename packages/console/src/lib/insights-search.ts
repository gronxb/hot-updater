import type { InsightsWindow } from "./insights-api";
import type { RecoveryInput } from "./insights-recovery";

const readText = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 1024
    ? value
    : undefined;
const readWindow = (value: unknown): InsightsWindow | undefined =>
  value === "24h" || value === "7d" || value === "30d" ? value : undefined;

export type InsightsSearch = {
  platform?: RecoveryInput["platform"];
  channel?: string;
  appVersion?: string;
  window?: InsightsWindow;
  bundleWindow?: InsightsWindow;
};

export function validateInsightsSearch(
  search: Record<string, unknown>,
): InsightsSearch {
  return {
    platform:
      search.platform === "all" ||
      search.platform === "ios" ||
      search.platform === "android"
        ? search.platform
        : undefined,
    channel: readText(search.channel),
    appVersion: readText(search.appVersion),
    window: readWindow(search.window),
    bundleWindow: readWindow(search.bundleWindow),
  };
}

export function validateDistributionSearch(search: Record<string, unknown>) {
  return {
    ...validateInsightsSearch(search),
    version: readText(search.version),
    page:
      typeof search.page === "number" &&
      Number.isSafeInteger(search.page) &&
      search.page > 0
        ? search.page
        : undefined,
  };
}
