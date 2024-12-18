import semver from "semver";
import type { Bundle, Platform } from "./types";

/**
 *
 * Filters based on semver. And sorts by the highest bundle version.
 *
 * * Range Expression Table:
 *
 * | Range Expression | Who gets the update                                                    |
 * |------------------|------------------------------------------------------------------------|
 * | 1.2.3            | Only devices running the specific binary app store version 1.2.3 of your app |
 * | *                | Any device configured to consume updates from your CodePush app         |
 * | 1.2.x            | Devices running major version 1, minor version 2 and any patch version of your app |
 * | 1.2.3 - 1.2.7    | Devices running any binary version between 1.2.3 (inclusive) and 1.2.7 (inclusive) |
 * | >=1.2.3 <1.2.7   | Devices running any binary version between 1.2.3 (inclusive) and 1.2.7 (exclusive) |
 * | 1.2              | Equivalent to >=1.2.0 <1.3.0                                            |
 * | ~1.2.3           | Equivalent to >=1.2.3 <1.3.0                                            |
 * | ^1.2.3           | Equivalent to >=1.2.3 <2.0.0                                            |
 */
export const filterTargetVersion = (
  bundles: Bundle[],
  targetVersion: string,
  platform?: Platform,
): Bundle[] => {
  // coerce currentVersion to a semver-compatible version
  const currentVersionCoerce = semver.coerce(targetVersion)?.version;

  // Filter bundles by platform and if currentVersion satisfies the targetVersion range
  const filteredBundles = bundles
    .filter((bundle) => {
      if (platform) {
        return bundle.platform === platform;
      }
      return true;
    })
    .filter(
      (bundle) =>
        targetVersion === "*" ||
        semver.satisfies(currentVersionCoerce ?? "*", bundle.targetVersion),
    );

  // Separate '*' versions from other versions
  const starVersions = filteredBundles.filter(
    (bundle) => bundle.targetVersion === "*",
  );
  const otherVersions = filteredBundles.filter(
    (bundle) => bundle.targetVersion !== "*",
  );

  // Sort other versions by their minimum semver value in descending order
  const sortedOtherVersions = otherVersions.sort((a, b) => {
    const minA = semver.minVersion(a.targetVersion);
    const minB = semver.minVersion(b.targetVersion);

    if (minA && minB) {
      return semver.rcompare(minA, minB);
    }
    return semver.rcompare(a.targetVersion, b.targetVersion);
  });

  // Combine '*' versions and sorted other versions
  const combinedSortedVersions = [...starVersions, ...sortedOtherVersions];

  // Sort by bundleId in descending order
  return combinedSortedVersions.sort((a, b) => b.id.localeCompare(a.id));
};
