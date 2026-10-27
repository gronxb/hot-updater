/**
 * The MIN_BUNDLE_ID a native build compiles in, which is also the ID of its
 * built-in bundle: a UUIDv7 of the build's millisecond whose random bits are
 * all zero, `<ts>-<ts>-7000-8000-000000000000`, as the SDK's podspec script
 * phase and Gradle task generate it. The bundles `hot-updater deploy` issued
 * before the build sort before it, and the ones it issues afterwards sort
 * after it. Bundle IDs share one space across platforms, so two builds that
 * start in the same millisecond get the same one: `native-build ios|android`
 * steps past an ID the registry holds before it builds, and the registry
 * refuses a second registration of one.
 */
export const createMinBundleId = (nowMs = Date.now()): string => {
  const timestamp = nowMs.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-000000000000`;
};
