import type { InsightsCoverage } from "@hot-updater/server/plugins/insights";

import { recoveryWindows } from "./insights-recovery";
import type { InsightsWindow } from "./insights-rpc";

/**
 * Bundles one Downloads chart compares at most: the newest two and two more.
 * Each one is a read of its counters over the period, and the chart's line
 * styles tell four apart.
 */
export const MAX_DOWNLOADS_RELEASES = 4;
/** Bundles the chart compares when none are chosen: the newest two. */
export const DEFAULT_DOWNLOADS_RELEASES = 2;
/** Bundle deployments the chart offers to add. */
export const DOWNLOADS_CANDIDATES = 10;

/** A deployed bundle, as the chart labels it. */
export type DownloadsRelease = {
  readonly releaseId: string;
  readonly deployedAtMs: number;
  readonly message: string | null;
  readonly targetAppVersion: string | null;
};

/** A channel and platform's newest bundle deployments. */
export type DownloadsReleasesInput = {
  readonly platform: "ios" | "android";
  readonly channel: string;
};

/** One bundle deployment, and with `withPrevious` the one before it. */
export type DownloadsReleaseInput = DownloadsReleasesInput & {
  readonly releaseId: string;
  readonly withPrevious?: boolean;
};

export type DownloadsReleaseResult = {
  readonly release: DownloadsRelease | null;
  readonly previous?: DownloadsRelease | null;
};

/** One bundle's downloads over the period that ends at `endMs`. */
export type ReleaseDownloadsInput = DownloadsReleasesInput & {
  readonly window: InsightsWindow;
  /** The end of an hour; every bundle of one chart reads the same one. */
  readonly endMs: number;
  readonly releaseId: string;
};

/**
 * A bundle's download reports in each interval of the period, every interval
 * present. Downloads count reports, not distinct installations.
 */
export type ReleaseDownloadsSeries = {
  readonly releaseId: string;
  readonly measuredAtMs: number;
  readonly coverage: InsightsCoverage;
  readonly points: readonly {
    readonly startMs: number;
    readonly downloads: number;
  }[];
  readonly totalDownloads: number;
};

const HOUR_MS = 3_600_000;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 1024;

const invalid = (): never => {
  throw new Error("Choose a platform, channel, period, and bundle.");
};

export function readDownloadsReleasesInput(
  input: DownloadsReleasesInput,
): DownloadsReleasesInput {
  if (
    !input ||
    (input.platform !== "ios" && input.platform !== "android") ||
    !isText(input.channel)
  )
    invalid();
  return { platform: input.platform, channel: input.channel };
}

export function readDownloadsReleaseInput(
  input: DownloadsReleaseInput,
): DownloadsReleaseInput {
  const scope = readDownloadsReleasesInput(input);
  if (
    !isText(input.releaseId) ||
    (input.withPrevious !== undefined &&
      typeof input.withPrevious !== "boolean")
  )
    invalid();
  return {
    ...scope,
    releaseId: input.releaseId,
    ...(input.withPrevious ? { withPrevious: true } : {}),
  };
}

export function readReleaseDownloadsInput(
  input: ReleaseDownloadsInput,
): ReleaseDownloadsInput {
  const scope = readDownloadsReleasesInput(input);
  if (
    !Object.hasOwn(recoveryWindows, input.window) ||
    typeof input.endMs !== "number" ||
    !Number.isSafeInteger(input.endMs) ||
    input.endMs <= 0 ||
    input.endMs % HOUR_MS !== 0 ||
    !isText(input.releaseId)
  )
    invalid();
  return {
    ...scope,
    window: input.window,
    endMs: input.endMs,
    releaseId: input.releaseId,
  };
}
