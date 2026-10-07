import { extractTimestampFromUUIDv7 } from "@hot-updater/plugin-core";
import { isUUIDv7 } from "@hot-updater/protocol";

import type { InsightsWindow } from "./insights-api";
import type { AppUsageScope, UsageWindow } from "./insights-usage";

const readText = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 1024
    ? value
    : undefined;
const readWindow = (value: unknown): InsightsWindow | undefined =>
  value === "24h" || value === "7d" || value === "30d" ? value : undefined;
/** Release health's chart: whether bundles are launched, or crash. */
export type HealthChart = "adoption" | "crashes";
const readHealthChart = (value: unknown): HealthChart | undefined =>
  value === "adoption" || value === "crashes" ? value : undefined;
/** Adoption's counts: each interval's (the default), or the running total. */
export type AdoptionTotal = "interval" | "cumulative";
const readUsageWindow = (value: unknown): UsageWindow | undefined =>
  value === "12m" ? value : readWindow(value);

export type InsightsSearch = {
  platform?: AppUsageScope["platform"];
  channel?: string;
  appVersion?: string;
  window?: UsageWindow;
  bundleWindow?: InsightsWindow;
  healthPlatform?: "ios" | "android";
  healthChannel?: string;
  releaseId?: string;
  healthChart?: HealthChart;
  /** Adoption as a running total; omitted, each interval's count. */
  adoptionTotal?: "cumulative";
  /**
   * Release health's compared bundles, comma-separated release IDs; omitted,
   * the focused release and the one before it, or the newest two.
   */
  bundles?: string;
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
    window: readUsageWindow(search.window),
    bundleWindow: readWindow(search.bundleWindow),
    healthPlatform:
      search.healthPlatform === "ios" || search.healthPlatform === "android"
        ? search.healthPlatform
        : undefined,
    healthChannel: readText(search.healthChannel),
    releaseId: readText(search.releaseId),
    healthChart: readHealthChart(search.healthChart),
    adoptionTotal:
      search.adoptionTotal === "cumulative" ? "cumulative" : undefined,
    bundles: readText(search.bundles),
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

/**
 * The shortest Release health period that still covers a release's first
 * hours: 24h within a day of its deployment, 7d within a week, else 30d.
 */
export function adoptionWindow(releaseId: string, now = Date.now()) {
  if (!isUUIDv7(releaseId)) return "7d" as const;
  const age = now - extractTimestampFromUUIDv7(releaseId);
  return age <= 86_400_000
    ? ("24h" as const)
    : age <= 7 * 86_400_000
      ? ("7d" as const)
      : ("30d" as const);
}

/** Release health's compared bundles from the `bundles` search value. */
export const comparedBundleIds = (value: string | undefined) =>
  value === undefined
    ? undefined
    : [...new Set(value.split(",").filter((id) => id.length > 0))];
