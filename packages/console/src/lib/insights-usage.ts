import type { RecoveryInput } from "./insights-recovery";

export type AppUsageInput = Omit<RecoveryInput, "releaseId">;
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
