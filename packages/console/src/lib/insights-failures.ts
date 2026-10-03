import type {
  InsightsFailureBreakdown,
  InsightsUpdateFailures,
} from "@hot-updater/server/plugins/insights";

import { recoveryWindows } from "./insights-recovery";
import type { InsightsWindow } from "./insights-rpc";
import type { InsightsEventRow } from "./insights-view";

export type { InsightsFailureBreakdown };

export type UpdateFailuresInput = {
  readonly platform: "ios" | "android";
  readonly channel: string;
  /** A release's failures; the channel's without it. */
  readonly releaseId?: string;
  /** The period that ends with the current hour; a release's since its first report without it. */
  readonly window?: InsightsWindow;
};

export type UpdateFailuresReport = InsightsUpdateFailures & {
  /** Where the period starts, or null since the release's first report. */
  readonly startMs: number | null;
  readonly endMs: number;
  readonly previous?: {
    readonly attemptRate: number | null;
    readonly checkRate: number | null;
    readonly complete: boolean;
  };
};

export function readUpdateFailuresInput(
  input: UpdateFailuresInput,
): UpdateFailuresInput {
  if (
    !input ||
    (input.platform !== "ios" && input.platform !== "android") ||
    typeof input.channel !== "string" ||
    !input.channel.trim() ||
    input.channel.length > 1_024 ||
    (input.releaseId !== undefined &&
      (typeof input.releaseId !== "string" ||
        !input.releaseId.trim() ||
        input.releaseId.length > 36)) ||
    (input.window === undefined
      ? input.releaseId === undefined
      : !Object.hasOwn(recoveryWindows, input.window))
  ) {
    throw new Error("Choose a platform, channel, and time window.");
  }
  return input;
}

/**
 * The failure rate of update attempts: failed download and install reports,
 * over those plus download reports. Null without either.
 */
export const failureRate = ({
  failedUpdates,
  downloads,
}: Pick<InsightsUpdateFailures, "failedUpdates" | "downloads">):
  | number
  | null =>
  failedUpdates + downloads === 0
    ? null
    : failedUpdates / (failedUpdates + downloads);

/** Of the downloads that tried a patch, the share that fell back to files or the archive. */
export const patchFallbackRate = ({
  patchDownloads,
  patchFallbacks,
}: Pick<InsightsUpdateFailures, "patchDownloads" | "patchFallbacks">):
  | number
  | null =>
  patchDownloads + patchFallbacks === 0
    ? null
    : patchFallbacks / (patchDownloads + patchFallbacks);

/** Installations whose update check failed, over the active ones; estimates, so at most 100%. */
export const checkFailureRate = ({
  failedInstallations,
  activeInstallations,
}: NonNullable<InsightsUpdateFailures["checks"]>): number | null =>
  activeInstallations === 0
    ? null
    : Math.min(1, failedInstallations / activeInstallations);

export const formatRate = (rate: number | null): string =>
  rate === null ? "—" : `${(rate * 100).toFixed(2)}%`;

const STAGES: Readonly<Record<string, string>> = {
  check: "Update check",
  download: "Download",
  install: "Install",
};

const REASONS: Readonly<Record<string, string>> = {
  network: "Network",
  http: "HTTP error",
  invalid_response: "Invalid response",
  hash_mismatch: "Hash mismatch",
  signature: "Signature",
  patch: "Patch",
  extract: "Extract",
  storage: "Storage",
};

export const failureStageLabel = (stage: string): string =>
  STAGES[stage] ?? "Unknown stage";

export const failureReasonLabel = (reason: string): string =>
  REASONS[reason] ?? "Unknown reason";

/** What else the client knew: its resource, HTTP status, origin code, and transport. */
export const failureDetailParts = (detail: {
  readonly resource?: string | null;
  readonly httpStatus?: number | null;
  readonly originCode?: string | null;
  readonly transport?: string | null;
}): string[] => [
  ...(detail.httpStatus == null ? [] : [`HTTP ${detail.httpStatus}`]),
  ...(detail.originCode == null ? [] : [detail.originCode]),
  ...(detail.transport == null ? [] : [detail.transport]),
  ...(detail.resource == null ? [] : [detail.resource]),
];

/** An update failure as one line: where, why, and what else the client knew. */
export const describeFailure = (
  failure: NonNullable<InsightsEventRow["failure"]>,
): string => {
  const message =
    failure.errorMessage ||
    (failure.reason === "unknown"
      ? "The client did not report a detailed cause"
      : failureReasonLabel(failure.reason));
  return [
    `${failureStageLabel(failure.stage)} failed: ${message}`,
    ...failureDetailParts(failure),
  ].join(" · ");
};
