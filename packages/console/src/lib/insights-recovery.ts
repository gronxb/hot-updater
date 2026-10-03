import type {
  InsightsCoverage,
  InsightsGetDistributionHistoryResult,
} from "@hot-updater/server/plugins/insights";

import type { InsightsWindow } from "./insights-rpc";

export type RecoveryInput = {
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly window: InsightsWindow;
  readonly releaseId?: string;
};

export type RecoveryReport = {
  readonly downloads: number;
  readonly distribution: InsightsGetDistributionHistoryResult;
  /**
   * Distinct installations that reported in the scope and period, or that
   * launched the release; estimated.
   */
  readonly activeInstallations: number;
  /**
   * Installation-days: each installation once for each UTC day it launched,
   * and once more on a day an update applied or recovered.
   */
  readonly activeDays: number;
  readonly failedLaunches: number;
  readonly points: readonly {
    readonly startMs: number;
    /** That UTC day's daily active installations. */
    readonly dailyActiveInstallations: number;
    readonly failedLaunches: number;
  }[];
  /** The chosen release's downloads over the period; null for a whole scope. */
  readonly adoption: ReleaseAdoption | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly measuredAtMs: number;
  readonly coverage: InsightsCoverage;
};

/**
 * A release's downloads in each interval of the period from its deployment,
 * and their running total. Downloads count reports, not distinct
 * installations: one that downloads the release again counts again.
 */
export type ReleaseAdoption = {
  /** From the release ID, a UUIDv7; null when it is not one. */
  readonly deployedAtMs: number | null;
  readonly intervalMs: number;
  readonly points: readonly {
    readonly startMs: number;
    readonly downloads: number;
    /** Downloads in the period up to this interval's end. */
    readonly totalDownloads: number;
  }[];
};

export const recoveryWindows = {
  "24h": { durationMs: 86_400_000, intervalMs: 3_600_000 },
  "7d": { durationMs: 7 * 86_400_000, intervalMs: 6 * 3_600_000 },
  "30d": { durationMs: 30 * 86_400_000, intervalMs: 86_400_000 },
} as const;

/**
 * Where a period ends: the end of the current UTC hour, as the server's
 * reporting overview ends. The counters keep whole hours, so this is the
 * latest end that still counts a report received just now; every Insights
 * card ends here, so their numbers cover the same hours.
 */
export const insightsPeriodEnd = (now: number): number =>
  Math.ceil(now / 3_600_000) * 3_600_000;

export function readRecoveryInput(input: RecoveryInput): RecoveryInput {
  if (
    !input ||
    (input.platform !== "ios" && input.platform !== "android") ||
    typeof input.channel !== "string" ||
    !input.channel.trim() ||
    input.channel.length > 1_024 ||
    !Object.hasOwn(recoveryWindows, input.window) ||
    (input.releaseId !== undefined &&
      (typeof input.releaseId !== "string" ||
        !input.releaseId.trim() ||
        input.releaseId.length > 1_024))
  ) {
    throw new Error("Choose a platform, channel, and time window.");
  }
  return input;
}
