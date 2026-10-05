import { recoveryWindows } from "./insights-recovery";
import type { InsightsWindow } from "./insights-rpc";

/**
 * Bundles Release health compares at most: the newest two and two more.
 * Each is a read of its counts over the period, and four hues stay apart.
 */
export const MAX_ADOPTION_RELEASES = 4;
/** Bundles Release health compares when none are chosen: the newest two. */
export const DEFAULT_ADOPTION_RELEASES = 2;
/** Bundle deployments Release health offers to add. */
export const ADOPTION_CANDIDATES = 10;
/** A crash rate at which Release health recommends rolling a bundle back. */
export const CRASH_RATE_THRESHOLD = 0.05;
/** Attempts below which a crash rate is too noisy to recommend anything. */
export const CRASH_MIN_ATTEMPTS = 20;

/** A deployed bundle, as Release health labels and rolls it back. */
export type AdoptionRelease = {
  readonly releaseId: string;
  readonly bundleId: string;
  readonly deployedAtMs: number;
  readonly targetAppVersion: string | null;
  readonly enabled: boolean;
  readonly revision: number;
};

/** A channel and platform's newest bundle deployments. */
export type AdoptionReleasesInput = {
  readonly platform: "ios" | "android";
  readonly channel: string;
};

/** One bundle deployment, and with `withPrevious` the one before it. */
export type AdoptionReleaseInput = AdoptionReleasesInput & {
  readonly releaseId: string;
  readonly withPrevious?: boolean;
};

export type AdoptionReleaseResult = {
  readonly release: AdoptionRelease | null;
  readonly previous?: AdoptionRelease | null;
};

/** The reports Release health charts per bundle. */
export type BundleEventType = "UPDATE_APPLIED" | "RECOVERED";

/** One bundle's reports of one type over the period that ends at `endMs`. */
export type BundleEventsInput = AdoptionReleasesInput & {
  readonly window: InsightsWindow;
  /** The end of an hour; every bundle of one chart reads the same one. */
  readonly endMs: number;
  readonly bundleId: string;
  readonly type: BundleEventType;
};

/**
 * A bundle's reports of one type in each interval of the period, every
 * interval present: applies to it or recoveries from it. They count
 * reports, not distinct installations.
 */
export type BundleEventsSeries = {
  readonly bundleId: string;
  readonly type: BundleEventType;
  readonly measuredAtMs: number;
  readonly points: readonly {
    readonly startMs: number;
    readonly events: number;
  }[];
  readonly total: number;
};

const HOUR_MS = 3_600_000;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 1024;

const invalid = (): never => {
  throw new Error("Choose a platform, channel, period, and bundle.");
};

export function readAdoptionReleasesInput(
  input: AdoptionReleasesInput,
): AdoptionReleasesInput {
  if (
    !input ||
    (input.platform !== "ios" && input.platform !== "android") ||
    !isText(input.channel)
  )
    invalid();
  return { platform: input.platform, channel: input.channel };
}

export function readAdoptionReleaseInput(
  input: AdoptionReleaseInput,
): AdoptionReleaseInput {
  const scope = readAdoptionReleasesInput(input);
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

export function readBundleEventsInput(
  input: BundleEventsInput,
): BundleEventsInput {
  const scope = readAdoptionReleasesInput(input);
  if (
    !Object.hasOwn(recoveryWindows, input.window) ||
    typeof input.endMs !== "number" ||
    !Number.isSafeInteger(input.endMs) ||
    input.endMs <= 0 ||
    input.endMs % HOUR_MS !== 0 ||
    !isText(input.bundleId) ||
    (input.type !== "UPDATE_APPLIED" && input.type !== "RECOVERED")
  )
    invalid();
  return {
    ...scope,
    window: input.window,
    endMs: input.endMs,
    bundleId: input.bundleId,
    type: input.type,
  };
}

/**
 * Of the installations that tried a bundle, the share whose launch crashed
 * and recovered: an installation that crashes may never report the apply,
 * so attempts count both.
 */
export const crashRateOf = (applied: number, recovered: number) => {
  const attempts = applied + recovered;
  return { attempts, rate: attempts === 0 ? 0 : recovered / attempts };
};

/** Whether a bundle's crashes call for rolling it back. */
export const recommendsRollback = (
  release: Pick<AdoptionRelease, "enabled">,
  applied: number,
  recovered: number,
) => {
  const { attempts, rate } = crashRateOf(applied, recovered);
  return (
    release.enabled &&
    attempts >= CRASH_MIN_ATTEMPTS &&
    rate >= CRASH_RATE_THRESHOLD
  );
};
