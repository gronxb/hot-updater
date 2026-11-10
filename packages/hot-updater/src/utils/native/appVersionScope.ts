import type { ConfigResponse } from "@hot-updater/cli-tools";

import type { NativeAppVersionScope } from "../version/getNativeAppVersion";

/**
 * The app a `nativeBuild` scheme builds, which picks its version in a
 * project that builds several apps with different versions.
 */
export const nativeBuildAppVersionScope = (
  config: Pick<ConfigResponse, "nativeBuild">,
  scheme: string,
): NativeAppVersionScope => {
  const iosScheme = config.nativeBuild.ios[scheme];
  const androidScheme = config.nativeBuild.android[scheme];
  return {
    ios: iosScheme && {
      scheme: iosScheme.scheme,
      bundleIdentifier: iosScheme.bundleIdentifier,
      configuration: iosScheme.configuration,
    },
    android: androidScheme && {
      variant: androidScheme.variant,
      applicationId: androidScheme.applicationId ?? androidScheme.packageName,
      appModuleName: androidScheme.appModuleName,
    },
  };
};
