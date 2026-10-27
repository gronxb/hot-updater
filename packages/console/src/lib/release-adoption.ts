import { recoveryWindows } from "./insights-recovery";
import type { InsightsWindow } from "./insights-rpc";

/**
 * Bundles Release health compares at most: the newest two and two more.
 * Each is a read of its counts over the period, and four hues stay apart.
 */
export const MAX_ADOPTION_RELEASES = 4;
/**
 * Bundles Release health compares when none are chosen: the two newest live
 * ones of one platform, or the newest live one of each.
 */
export const DEFAULT_ADOPTION_RELEASES = 2;
/** Bundle deployments of each platform Release health offers to add. */
export const ADOPTION_CANDIDATES = 10;
/** A crash rate at which Release health recommends rolling a bundle back. */
export const CRASH_RATE_THRESHOLD = 0.05;
/** Attempts below which a crash rate is too noisy to recommend anything. */
export const CRASH_MIN_ATTEMPTS = 20;

/** Release health's platforms: one, or both side by side. */
export type HealthPlatform = "all" | "ios" | "android";

/** A deployed bundle, as Release health labels and rolls it back. */
export type AdoptionRelease = {
  readonly releaseId: string;
  readonly bundleId: string;
  readonly platform: "ios" | "android";
  readonly deployedAtMs: number;
  readonly targetAppVersion: string | null;
  readonly enabled: boolean;
  /** Whether a device can get it now: its scope's catalog still serves it. */
  readonly live: boolean;
  readonly revision: number;
};

/** A channel's newest bundle deployments, of one platform or both. */
export type AdoptionReleasesInput = {
  readonly platform: HealthPlatform;
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

/**
 * What Release health charts per bundle: downloads (download reports, and
 * the downloads a launch or crash implied when its download report never
 * arrived), launches (apply reports, and the kept reports that moved an
 * installation to the bundle with no apply report), and recoveries.
 */
export type BundleEventType = "DOWNLOADED" | "LAUNCHED" | "RECOVERED";

/** One bundle's reports of one type over the period that ends at `endMs`. */
export type BundleEventsInput = {
  /** The bundle's own platform. */
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly window: InsightsWindow;
  /** The end of an hour; every bundle of one chart reads the same one. */
  readonly endMs: number;
  readonly bundleId: string;
  readonly type: BundleEventType;
};

/**
 * A bundle's counts of one type in each interval of the period, every
 * interval present: downloads of it, launches of it, or recoveries from it.
 * Each counts an installation once when it downloads the bundle, first
 * reports running it, or crashes on it; one that comes back counts again.
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
    (input.platform !== "all" &&
      input.platform !== "ios" &&
      input.platform !== "android") ||
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
  const { platform, channel } = readAdoptionReleasesInput(input);
  if (
    platform === "all" ||
    !Object.hasOwn(recoveryWindows, input.window) ||
    typeof input.endMs !== "number" ||
    !Number.isSafeInteger(input.endMs) ||
    input.endMs <= 0 ||
    input.endMs % HOUR_MS !== 0 ||
    !isText(input.bundleId) ||
    (input.type !== "DOWNLOADED" &&
      input.type !== "LAUNCHED" &&
      input.type !== "RECOVERED")
  )
    invalid();
  return {
    platform: platform as BundleEventsInput["platform"],
    channel,
    window: input.window,
    endMs: input.endMs,
    bundleId: input.bundleId,
    type: input.type,
  };
}

/**
 * Of the installations that tried a bundle, the share whose launch crashed
 * and rolled back: one that crashes never reports a launch, so attempts
 * count both.
 */
export const crashRateOf = (launched: number, recovered: number) => {
  const attempts = launched + recovered;
  return { attempts, rate: attempts === 0 ? 0 : recovered / attempts };
};

/**
 * The bundles Release health compares when none are chosen, from the
 * candidates newest first: the two newest live bundles of one platform, or
 * the newest live one of each; without any live one, the newest two.
 */
export const defaultAdoptionReleases = (
  candidates: readonly AdoptionRelease[],
  platform: HealthPlatform,
): readonly string[] => {
  const live = (
    platform === "all" ? (["ios", "android"] as const) : [platform]
  ).flatMap((each) =>
    candidates
      .filter((release) => release.platform === each && release.live)
      .slice(0, platform === "all" ? 1 : DEFAULT_ADOPTION_RELEASES),
  );
  return (live.length > 0 ? live : candidates)
    .slice(0, DEFAULT_ADOPTION_RELEASES)
    .map((release) => release.releaseId);
};

/** Whether a bundle's crashes call for rolling it back. */
export const recommendsRollback = (
  release: Pick<AdoptionRelease, "enabled">,
  launched: number,
  recovered: number,
) => {
  const { attempts, rate } = crashRateOf(launched, recovered);
  return (
    release.enabled &&
    attempts >= CRASH_MIN_ATTEMPTS &&
    rate >= CRASH_RATE_THRESHOLD
  );
};
