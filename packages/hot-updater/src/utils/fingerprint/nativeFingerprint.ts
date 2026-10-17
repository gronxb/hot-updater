import {
  type FingerprintOptions,
  type FingerprintResult,
  getOtaFingerprintOptions,
} from "./common";
import { getExpoFingerprintEngine, loadExpoFingerprint } from "./dependency";

/**
 * Calculates the project's native fingerprint with the build adapter's
 * fingerprint, or with `@expo/fingerprint` for an adapter without one.
 */
export async function nativeFingerprint(
  path: string,
  options: FingerprintOptions,
): Promise<FingerprintResult> {
  const { provider, ...providerOptions } = options;
  if (provider) return provider(providerOptions);
  const platform = options.platform;
  const [{ createFingerprintAsync }, engine] = await Promise.all([
    loadExpoFingerprint(path),
    getExpoFingerprintEngine(path),
  ]);
  const fingerprint = await createFingerprintAsync(
    path,
    await getOtaFingerprintOptions(platform, path, options),
  );
  return { engine, ...fingerprint };
}
