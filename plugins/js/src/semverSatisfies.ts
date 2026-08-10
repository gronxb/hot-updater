import { coerce, satisfies } from "verkit";

export const semverSatisfies = (
  targetAppVersion: string,
  currentVersion: string,
) => {
  const currentCoerce = coerce(currentVersion);
  if (!currentCoerce) {
    return false;
  }

  return satisfies(currentCoerce, targetAppVersion);
};
