import type { InsightsCoverage } from "@hot-updater/plugin-core";

import type { InsightsWindow } from "./insights-rpc";

export type RecoveryInput = {
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly window: InsightsWindow;
  readonly releaseId?: string;
};

export type RecoveryReport = {
  readonly downloads: number;
  readonly uniqueUsers: number;
  readonly launches: number;
  readonly failedLaunches: number;
  readonly points: readonly {
    readonly startMs: number;
    readonly launches: number;
    readonly failedLaunches: number;
  }[];
  readonly startMs: number;
  readonly endMs: number;
  readonly measuredAtMs: number;
  readonly coverage: InsightsCoverage;
};

export const recoveryWindows = {
  "24h": { durationMs: 86_400_000, intervalMs: 3_600_000 },
  "7d": { durationMs: 7 * 86_400_000, intervalMs: 6 * 3_600_000 },
  "30d": { durationMs: 30 * 86_400_000, intervalMs: 86_400_000 },
} as const;

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
