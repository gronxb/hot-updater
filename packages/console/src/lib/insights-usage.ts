export type AppUsageInput = {
  readonly platform: "all" | "ios" | "android";
  readonly channel: string;
  readonly appVersion?: string;
  readonly window: UsageWindow;
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
  /** The native build's built-in bundle, when the installations run it. */
  readonly builtinBundleId: string | null;
  readonly installations: number;
};

export type AppUsageReport = {
  readonly bundleDistribution: readonly BundleDistribution[];
  readonly activeInstallations: number;
  readonly sinceMs: number;
  /**
   * Where the distribution starts: the start of the UTC day that contains the
   * period's start. Latest reports are counted by UTC day, so the
   * distribution covers every UTC day the period touches.
   */
  readonly distributionSinceMs: number;
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
  "12m": { label: "YAU", period: "12 months", interval: "week" },
} as const;

/**
 * An App usage period. Hourly counts are kept 90 days, so the 12-month
 * period counts whole UTC days, from the daily counts kept 13 months.
 */
export type UsageWindow = keyof typeof usageMetrics;

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
