import semver from "semver";

export function getInjectedSdkVersion() {
  const sdkVersion = import.meta.env.VITE_HOT_UPDATER_SDK_VERSION?.trim();

  return sdkVersion || null;
}

export function getNormalizedSdkVersionRange(
  sdkVersion: string | null | undefined,
) {
  if (!sdkVersion) {
    return null;
  }

  return semver.validRange(sdkVersion.trim());
}

export function canSdkVersionSatisfy(
  sdkVersion: string | null | undefined,
  supportedRange: string,
) {
  const normalizedSdkVersionRange = getNormalizedSdkVersionRange(sdkVersion);
  const normalizedSupportedRange = semver.validRange(supportedRange.trim());

  if (!normalizedSdkVersionRange || !normalizedSupportedRange) {
    return false;
  }

  return semver.subset(normalizedSdkVersionRange, normalizedSupportedRange);
}

export function canSdkVersionAtLeast(
  sdkVersion: string | null | undefined,
  minVersion: string,
) {
  const normalizedMinVersion = semver.valid(minVersion.trim());

  if (!normalizedMinVersion) {
    return false;
  }

  return canSdkVersionSatisfy(sdkVersion, `>=${normalizedMinVersion}`);
}

export function canSdkVersion(minVersion: string) {
  return canSdkVersionAtLeast(getInjectedSdkVersion(), minVersion);
}
