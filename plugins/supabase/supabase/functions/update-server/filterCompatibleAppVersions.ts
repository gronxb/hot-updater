import semver from "npm:semver@7.7.1";

const semverSatisfies = (targetAppVersion: string, currentVersion: string) => {
  const currentCoerce = semver.coerce(currentVersion);
  if (!currentCoerce) {
    return false;
  }

  return semver.satisfies(currentCoerce.version, targetAppVersion);
};

/**
 * Filters target app versions that are compatible with the current app version.
 * Returns only versions that are compatible with the current version according to semver rules.
 *
 * @param targetAppVersionList - List of target app versions to filter
 * @param currentVersion - Current app version
 * @returns Array of target app versions compatible with the current version
 */
export const filterCompatibleAppVersions = (
  targetAppVersionList: string[],
  currentVersion: string,
) => {
  const compatibleAppVersionList = targetAppVersionList.filter((version) =>
    semverSatisfies(version, currentVersion),
  );

  return compatibleAppVersionList.sort((a, b) => b.localeCompare(a));
};
