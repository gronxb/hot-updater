import { reactNativeCliFingerprint } from "@hot-updater/cli-tools";

import type { FingerprintOptions, FingerprintResult } from "./common";

/**
 * Calculates the project's native fingerprint with the build adapter's
 * fingerprint, or with React Native CLI's for an adapter without one.
 */
export async function nativeFingerprint(
  path: string,
  options: FingerprintOptions,
): Promise<FingerprintResult> {
  const { provider, ...providerOptions } = options;
  return provider
    ? provider(providerOptions)
    : reactNativeCliFingerprint(path, providerOptions);
}
