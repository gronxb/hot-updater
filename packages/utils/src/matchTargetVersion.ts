import semver from "semver";
import type { Platform } from "./types";

export type MatchBundle = {
  targetVersion: string;
  latestBundleId: string;
  path: string;
  platform: Platform;
};

export const matchTargetVersion = (
  matchBundles: MatchBundle[],
  current: {
    version: string;
    bundleId: string;
    platform: Platform;
  },
) => {
  const matchBundle = matchBundles
    .filter((bundle) => bundle.platform === current.platform)
    .find((bundle) => {
      return semver.satisfies(current.version, bundle.targetVersion);
    });
  return matchBundle?.path;
};
