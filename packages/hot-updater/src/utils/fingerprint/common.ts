import { getCwd, loadConfig, p } from "@hot-updater/cli-tools";
import type {
  FingerprintExtraSources,
  NativeFingerprint,
  NativeFingerprintOptions,
  NativeFingerprintSource,
} from "@hot-updater/plugin-core";

export const appendFingerprintExtraSources = (
  extraSources: FingerprintExtraSources | undefined,
  additions: readonly string[],
): FingerprintExtraSources | undefined => {
  if (additions.length === 0) return extraSources;
  const append = (sources: readonly string[] = []) => [
    ...new Set([...sources, ...additions]),
  ];
  if (!extraSources || Array.isArray(extraSources)) return append(extraSources);
  return {
    ios: append(extraSources.ios),
    android: append(extraSources.android),
  };
};

export const ensureFingerprintConfig = async (
  additionalExtraSources?: readonly string[],
) => {
  const config = await loadConfig(null);
  if (config.updateStrategy === "appVersion") {
    p.log.error(
      "The updateStrategy in hot-updater.config.ts is set to 'appVersion'. This command only works with 'fingerprint' strategy.",
    );
    process.exit(1);
  }
  let nativeExtraSources = additionalExtraSources;
  if (nativeExtraSources === undefined) {
    const buildPlugin = await config.build({ cwd: getCwd() });
    nativeExtraSources =
      (await buildPlugin.nativeBuild?.getFingerprintExtraSources?.()) ?? [];
  }
  return {
    ...config.fingerprint,
    extraSources: appendFingerprintExtraSources(
      config.fingerprint.extraSources,
      nativeExtraSources,
    ),
  };
};

export type FingerprintOptions = NativeFingerprintOptions;
export type FingerprintResult = NativeFingerprint;
export type FingerprintSource = NativeFingerprintSource;

const isFingerprintPair = (
  value: Record<string, unknown>,
): value is { android: FingerprintResult; ios: FingerprintResult } => {
  const android = value["android"];
  const ios = value["ios"];
  return (
    typeof android === "object" &&
    android !== null &&
    typeof ios === "object" &&
    ios !== null &&
    "hash" in android &&
    "hash" in ios
  );
};

export function isFingerprintEquals(
  lhs?: FingerprintResult | null,
  rhs?: FingerprintResult | null,
): boolean;
export function isFingerprintEquals(
  lhs?: {
    android: FingerprintResult | null;
    ios: FingerprintResult | null;
  } | null,
  rhs?: {
    android: FingerprintResult | null;
    ios: FingerprintResult | null;
  } | null,
): boolean;
export function isFingerprintEquals(
  lhs?: object | null,
  rhs?: object | null,
): boolean {
  if (!lhs || !rhs) return false;
  const left = lhs as Record<string, unknown>;
  const right = rhs as Record<string, unknown>;
  if (isFingerprintPair(left) && isFingerprintPair(right)) {
    return (
      left["android"].hash === right["android"].hash &&
      left["ios"].hash === right["ios"].hash
    );
  }
  if (!isFingerprintPair(left) && !isFingerprintPair(right)) {
    return left["hash"] === right["hash"];
  }
  return false;
}
