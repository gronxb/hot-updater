import type { InsightsWindow } from "./insights-api";
import type { AppUsageScope } from "./insights-usage";

const readText = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 1024
    ? value
    : undefined;
const readWindow = (value: unknown): InsightsWindow | undefined =>
  value === "24h" || value === "7d" || value === "30d" ? value : undefined;

export type InsightsSearch = {
  platform?: AppUsageScope["platform"];
  channel?: string;
  appVersion?: string;
  window?: InsightsWindow;
  bundleWindow?: InsightsWindow;
  healthPlatform?: "ios" | "android";
  healthChannel?: string;
  releaseId?: string;
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
    healthPlatform:
      search.healthPlatform === "ios" || search.healthPlatform === "android"
        ? search.healthPlatform
        : undefined,
    healthChannel: readText(search.healthChannel),
    releaseId: readText(search.releaseId),
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
