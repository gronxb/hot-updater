import type { InsightsWindow } from "./insights-rpc";

export type RecoveryInput = {
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly window: InsightsWindow;
  readonly releaseId?: string;
};

export type RecoveryPoint = {
  readonly startMs: number;
  readonly active: number | null;
  readonly recoveredInstallations: number;
  readonly applied: number;
  readonly recovered: number;
  readonly rate: number | null;
  readonly spike: boolean;
};

export type RecoverySeries = {
  readonly releaseId: string;
  readonly firstAppliedAtMs: number | null;
  readonly activeInstallations: number;
  readonly recoveredInstallations: number;
  readonly points: readonly RecoveryPoint[];
};

export type RecoveryReport = {
  readonly sinceMs: number;
  readonly beforeReceivedAtMs: number;
  readonly intervalMs: number;
  readonly truncated: boolean;
  readonly unattributedInstallations: number;
  readonly series: readonly RecoverySeries[];
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
