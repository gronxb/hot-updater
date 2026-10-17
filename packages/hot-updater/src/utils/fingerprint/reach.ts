import type { HotUpdaterCoreApi } from "@hot-updater/plugin-core";

/**
 * How many of a channel's newest releases deploy reads to find the
 * fingerprints it serves: one bounded page of an index the read budget pins.
 */
export const RECENT_RELEASE_LIMIT = 20;

export interface ServedFingerprint {
  readonly hash: string;
  readonly latestReleaseAtMs: number;
}

/**
 * The fingerprints other than `fingerprintHash` that the channel's newest
 * enabled releases target on the platform, newest first. Builds on them don't
 * receive a release for `fingerprintHash`.
 */
export const findOtherServedFingerprints = async ({
  core,
  channel,
  platform,
  fingerprintHash,
}: {
  core: Pick<HotUpdaterCoreApi, "findChannelByName" | "listReleases">;
  channel: string;
  platform: "ios" | "android";
  fingerprintHash: string;
}): Promise<ServedFingerprint[]> => {
  const found = await core.findChannelByName(channel);
  if (!found) return [];
  const releases = await core.listReleases({
    filter: {
      kind: "channelPlatform",
      channelId: found.id,
      platform,
      enabled: true,
    },
    order: "desc",
    limit: RECENT_RELEASE_LIMIT,
  });
  const served = new Map<string, number>();
  for (const release of releases) {
    const hash = release.fingerprint_hash;
    if (
      release.strategy === "FINGERPRINT" &&
      hash &&
      hash !== fingerprintHash &&
      !served.has(hash)
    ) {
      served.set(hash, release.created_at_ms);
    }
  }
  return [...served].map(([hash, latestReleaseAtMs]) => ({
    hash,
    latestReleaseAtMs,
  }));
};

/** Tells who a fingerprint deploy leaves out, or null when nobody. */
export const describeFingerprintReach = ({
  others,
  label,
  channel,
  fingerprintHash,
}: {
  others: readonly ServedFingerprint[];
  label: string;
  channel: string;
  fingerprintHash: string;
}): string | null => {
  if (others.length === 0) return null;
  const list = others
    .map(
      ({ hash, latestReleaseAtMs }) =>
        `${hash.slice(0, 10)} (latest release ${new Date(latestReleaseAtMs).toISOString().slice(0, 10)})`,
    )
    .join(", ");
  return `${label} builds on other fingerprints in ${channel} won't receive this update: ${list}. They receive it after users install a build with fingerprint ${fingerprintHash.slice(0, 10)}.`;
};
