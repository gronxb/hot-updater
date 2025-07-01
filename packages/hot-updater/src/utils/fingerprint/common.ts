import * as p from "@clack/prompts";
import {
  type FingerprintSource,
  type Options,
  SourceSkips,
} from "@expo/fingerprint";
import { loadConfig } from "@hot-updater/plugin-core";
import { processExtraSources } from "./processExtraSources";

export const ensureFingerprintConfig = async () => {
  const config = await loadConfig(null);
  if (config.updateStrategy === "appVersion") {
    p.log.error(
      "The updateStrategy in hot-updater.config.ts is set to 'appVersion'. This command only works with 'fingerprint' strategy.",
    );
    process.exit(1);
  }
  return config.fingerprint;
};

export function getFingerprintOptions(
  platform: "ios" | "android",
  path: string,
  options: FingerprintOptions,
): Options {
  return {
    platforms: [platform],
    ignorePaths: [
      "**/android/**/strings.xml",
      "**/ios/**/*.plist",
      "**/.gitignore",
      ...options.ignorePaths,
    ],
    sourceSkips: SourceSkips.GitIgnore | SourceSkips.PackageJsonScriptsAll,
    extraSources: processExtraSources(
      options.extraSources,
      path,
      options.ignorePaths,
    ),
    debug: options.debug,
  };
}

export type FingerprintSources = {
  extraSources: string[];
  ignorePaths: string[];
};

export type FingerprintOptions = {
  platform: "ios" | "android";
  extraSources: string[];
  ignorePaths: string[];
  debug?: boolean;
};

export type FingerprintResult = {
  hash: string;
  sources: FingerprintSource[];
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
  lhs?: Record<string, any> | null,
  rhs?: Record<string, any> | null,
): boolean {
  if (!lhs || !rhs) return false;
  if (isFingerprintResultsObject(lhs) && isFingerprintResultsObject(rhs)) {
    return (
      lhs.android.hash === rhs.android.hash && lhs.ios.hash === rhs.ios.hash
    );
  }
  if (!isFingerprintResultsObject(lhs) && !isFingerprintResultsObject(rhs)) {
    return lhs["hash"] === rhs["hash"];
  }

  return false;

  function isFingerprintResultsObject(
    result: Record<string, any>,
  ): result is { android: FingerprintResult; ios: FingerprintResult } {
    return (
      typeof result["android"] === "object" &&
      typeof result["ios"] === "object" &&
      !!result["android"]?.hash &&
      !!result["ios"]?.hash
    );
  }
}
