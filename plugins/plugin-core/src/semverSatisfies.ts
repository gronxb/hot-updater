import semver from "semver";

export const semverSatisfies = (
  targetAppVersion: string,
  currentVersion: string,
) => {
  const currentCoerce = semver.coerce(currentVersion);
  if (!currentCoerce) {
    return false;
  }

  return semver.satisfies(currentCoerce.version, targetAppVersion);
};
