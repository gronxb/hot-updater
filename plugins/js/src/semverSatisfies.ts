import semver from "semver";

export const semverSatisfies = (
  targetVersion: string,
  currentVersion: string,
) => {
  const currentCoerce = semver.coerce(currentVersion);
  if (!currentCoerce) {
    throw new Error("Invalid current version");
  }

  return semver.satisfies(currentCoerce.version, targetVersion);
};
