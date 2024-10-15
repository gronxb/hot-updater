import semver from "semver";
import type { Platform } from "./types";

export type MatchSource = {
  targetVersion: string;
  latestBundleVersion: string;
  path: string;
  platform: Platform;
};

export const matchTargetVersion = (
  matchSources: MatchSource[],
  current: {
    version: string;
    bundleVersion: string;
    platform: Platform;
  },
) => {
  const matchSource = matchSources
    .filter((source) => source.platform === current.platform)
    .find((source) => {
      return semver.satisfies(current.version, source.targetVersion);
    });
  return matchSource?.path;
};
