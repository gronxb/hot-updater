import { coerce, normalizeFull } from "verkit";

/**
 * The form of an app version that the device and the server compare:
 * `major.minor.patch` of the first version in `appVersion`, such as `1.4.0`
 * for `v1.4`, or null when it holds none. Prerelease and build parts are
 * dropped.
 */
export function canonicalizeAppVersion(appVersion: string): string | null {
  const version = coerce(appVersion);
  return version ? normalizeFull(version) : null;
}
