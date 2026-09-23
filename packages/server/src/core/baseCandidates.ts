import type { ReleaseRow } from "@hot-updater/plugin-core";
import { findMinimumForRange, rangesIntersect, tryParseRange } from "verkit";

/** Minor lines one release range may cover; a wider range keeps its lowest lines. */
export const MINOR_LINE_CAP = 16;

export interface MinorLines {
  /** `major.minor` lines, lowest first. */
  readonly lines: readonly string[];
  /** The range covers more lines than it kept. */
  readonly truncated: boolean;
}

/** The minor lines a semver range covers, lowest first, at most `cap`; null for an invalid range. */
export const minorLinesOf = (
  range: string,
  cap = MINOR_LINE_CAP,
): MinorLines | null => {
  const parsed = tryParseRange(range);
  if (parsed === null) return null;
  const found = new Map<string, readonly [number, number]>();
  for (const set of parsed.sets) {
    const exact = set.length === 1 && set[0]?.operator === "" && set[0].version;
    if (exact) {
      found.set(`${exact.major}.${exact.minor}`, [exact.major, exact.minor]);
      continue;
    }
    const interval = { options: parsed.options, sets: [set] };
    const min = findMinimumForRange(interval);
    if (min === null) continue;
    // A set is one interval, so its lines run on from its minimum's line.
    for (
      let minor = min.minor;
      minor <= min.minor + cap &&
      rangesIntersect(interval, `${min.major}.${minor}.x`);
      minor += 1
    ) {
      found.set(`${min.major}.${minor}`, [min.major, minor]);
    }
  }
  const lines = [...found.values()].sort(
    (left, right) => left[0] - right[0] || left[1] - right[1],
  );
  return {
    lines: lines.slice(0, cap).map(([major, minor]) => `${major}.${minor}`),
    truncated: lines.length > cap,
  };
};

const candidateKey = (
  channelId: string,
  platform: string,
  target: readonly ["fingerprint" | "app-version", string],
) => JSON.stringify([channelId, platform, ...target]);

/** The `base_candidates` keys an enabled bundle release holds: its fingerprint, or each minor line of its range. */
export const releaseBaseCandidateKeys = (
  release: Pick<
    ReleaseRow,
    | "kind"
    | "bundle_id"
    | "enabled"
    | "channel_id"
    | "platform"
    | "strategy"
    | "fingerprint_hash"
    | "target_app_version"
  >,
): string[] => {
  if (!release.enabled || release.kind !== "BUNDLE" || !release.bundle_id) {
    return [];
  }
  const { channel_id: channelId, platform } = release;
  if (release.strategy === "FINGERPRINT") {
    return release.fingerprint_hash
      ? [
          candidateKey(channelId, platform, [
            "fingerprint",
            release.fingerprint_hash,
          ]),
        ]
      : [];
  }
  const covered =
    release.target_app_version === null
      ? null
      : minorLinesOf(release.target_app_version);
  return (covered?.lines ?? []).map((line) =>
    candidateKey(channelId, platform, ["app-version", line]),
  );
};

/** A new bundle's key for its auto-patch base search; null when its target spans several minor lines. */
export const targetBaseCandidateKey = (target: {
  readonly channelId: string;
  readonly platform: string;
  readonly fingerprintHash: string | null;
  readonly appVersion: string | null;
}): string | null => {
  if (target.fingerprintHash) {
    return candidateKey(target.channelId, target.platform, [
      "fingerprint",
      target.fingerprintHash,
    ]);
  }
  const covered =
    target.appVersion === null ? null : minorLinesOf(target.appVersion, 1);
  const line = covered?.truncated === false ? covered.lines[0] : undefined;
  return line === undefined
    ? null
    : candidateKey(target.channelId, target.platform, ["app-version", line]);
};
