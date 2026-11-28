/**
 * What every E2E build's MIN_BUNDLE_ID ends with. The built-in bundle's ID,
 * unlike an OTA bundle's, ends with it, which is how the harness tells them
 * apart.
 */
export const BUILT_IN_MIN_BUNDLE_ID_SUFFIX = "7000-8000-000000000000";

/** A built-in bundle ID as an E2E build compiles it in. */
export const BUILT_IN_MIN_BUNDLE_ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000/;

/**
 * The MIN_BUNDLE_ID of one E2E build: a UUIDv7 of the build's start time
 * with the built-in suffix, so every bundle deployed after the build is
 * newer. Each build has its own, as each release build has: a native build
 * registry takes an ID once.
 */
export function createE2eMinBundleId(buildStartedAtMs: number): string {
  const timestamp = buildStartedAtMs.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-${BUILT_IN_MIN_BUNDLE_ID_SUFFIX}`;
}
