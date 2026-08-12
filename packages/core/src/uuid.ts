export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Suffix shared by every build-time generated baseline bundle id
 * (`generateMinBundleId()`): a UUIDv7 whose random bits are all zero.
 *
 * A fresh install that has never applied an OTA update reports this id as its
 * current bundle id even though it is never stored as a deployed bundle.
 */
const BUILT_IN_BASELINE_BUNDLE_ID_SUFFIX = "-7000-8000-000000000000";

/**
 * Whether the given bundle id is a build-time generated built-in baseline id.
 *
 * Such ids identify the JS bundle embedded in the native app binary, not a
 * deployed OTA bundle, so they never have a database record.
 */
export const isBuiltInBaselineBundleId = (bundleId: string): boolean =>
  bundleId.endsWith(BUILT_IN_BASELINE_BUNDLE_ID_SUFFIX);
