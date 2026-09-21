import type { InsightsWindow } from "./insights-api";

export type AppUsageInput = {
  readonly platform: "all" | "ios" | "android";
  readonly channel: string;
  readonly appVersion?: string;
  readonly window: InsightsWindow;
};
export type AppUsageScope = Omit<AppUsageInput, "window">;

export type UsageDistribution = {
  readonly name: string;
  readonly installations: number;
};

export type BundleDistribution = {
  readonly appVersion: string;
  readonly platform: "ios" | "android";
  readonly releaseId: string | null;
  readonly installations: number;
};

export type AppUsageReport = {
  readonly bundleDistribution: readonly BundleDistribution[];
  readonly activeInstallations: number;
  readonly sinceMs: number;
  readonly beforeReceivedAtMs: number;
  readonly intervalMs: number;
  readonly truncated: boolean;
  readonly appVersions: readonly string[];
  readonly versions: readonly UsageDistribution[];
  readonly platforms: readonly UsageDistribution[];
  readonly points: readonly {
    readonly startMs: number;
    readonly installations: number | null;
  }[];
};

export const usageMetrics = {
  "24h": { label: "DAU", period: "24 hours", interval: "hour" },
  "7d": { label: "WAU", period: "7 days", interval: "6 hours" },
  "30d": { label: "MAU", period: "30 days", interval: "day" },
} as const;

export function readAppUsageInput(input: AppUsageInput): AppUsageInput {
  if (
    !input ||
    (input.platform !== "all" &&
      input.platform !== "ios" &&
      input.platform !== "android") ||
    typeof input.channel !== "string" ||
    !input.channel.trim() ||
    input.channel.length > 1_024 ||
    !Object.hasOwn(usageMetrics, input.window) ||
    (input.appVersion !== undefined &&
      (typeof input.appVersion !== "string" ||
        !input.appVersion.trim() ||
        input.appVersion.length > 1_024))
  ) {
    throw new Error("Choose App usage filters and a time window.");
  }
  return input;
}
