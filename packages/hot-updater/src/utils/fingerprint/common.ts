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

/**
 * Utility function that takes an array of extensions and generates glob patterns to allow those extensions.
 * @param extensions Array of allowed extensions (e.g., ["*.swift", "*.kt", "*.java"])
 * @returns Array of glob patterns
 */
function allowExtensions(extensions: string[]): string[] {
  return extensions.map((ext) => `!**/${ext}`);
}

/**
 * Utility function that returns the default ignore paths.
 * @returns Array of default ignore paths
 */
function getDefaultIgnorePaths(): string[] {
  return ["**/*", "**/.build/**/*", "**/build/"];
}

export function getOtaFingerprintOptions(
  platform: "ios" | "android",
  path: string,
  options: FingerprintOptions,
): Options {
  return {
    platforms: [platform],
    ignorePaths: [
      ...getDefaultIgnorePaths(),
      ...allowExtensions([
        // iOS native code
        "*.swift",
        "*.h",
        "*.m",
        "*.mm",

        // Android native code
        "*.kt",
        "*.java",

        // C/C++ native code
        "*.cpp",
        "*.hpp",
        "*.c",
        "*.cc",
        "*.cxx",

        // Build configuration files
        "*.podspec",
        "*.gradle",
        "*.kts", // Kotlin Script (Gradle build scripts)
        "CMakeLists.txt",
        "Android.mk",
        "Application.mk",

        // Additional native code and build files
        "*.pro", // ProGuard rules
        "*.mk", // Makefiles
        "*.cmake", // CMake files
        "*.ninja", // Ninja build files
        "Makefile", // Makefile (no extension)
        "*.bazel", // Bazel build files
        "*.buck", // Buck build files
        "BUILD", // Bazel BUILD files
        "WORKSPACE", // Bazel WORKSPACE files
        "BUILD.bazel", // Bazel BUILD files with extension
        "WORKSPACE.bazel", // Bazel WORKSPACE files with extension
      ]),
    ],
    sourceSkips:
      SourceSkips.GitIgnore |
      SourceSkips.PackageJsonScriptsAll |
      SourceSkips.PackageJsonAndroidAndIosScriptsIfNotContainRun |
      SourceSkips.ExpoConfigAll |
      SourceSkips.ExpoConfigVersions |
      SourceSkips.ExpoConfigNames |
      SourceSkips.ExpoConfigRuntimeVersionIfString |
      SourceSkips.ExpoConfigAssets |
      SourceSkips.ExpoConfigExtraSection |
      SourceSkips.ExpoConfigEASProject |
      SourceSkips.ExpoConfigSchemes,
    extraSources: processExtraSources(options.extraSources ?? [], path),
    debug: options.debug,
  };
}

export type FingerprintSources = {
  extraSources: string[];
};

export type FingerprintOptions = {
  platform: "ios" | "android";
  extraSources?: string[];
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
