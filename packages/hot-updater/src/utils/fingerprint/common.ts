import { getCwd, loadConfig, p } from "@hot-updater/cli-tools";
import type {
  FingerprintExtraSources,
  NativeFingerprint,
  NativeFingerprintProvider,
  NativeFingerprintSource,
} from "@hot-updater/plugin-core";

import { isExpo } from "../expoDetection";
import { loadExpoFingerprint } from "./dependency";
import {
  processExtraSources,
  resolveExtraSources,
} from "./processExtraSources";

export const appendFingerprintExtraSources = (
  extraSources: FingerprintExtraSources | undefined,
  additions: readonly string[],
): FingerprintExtraSources | undefined => {
  if (additions.length === 0) return extraSources;

  const append = (sources: readonly string[] = []) => [
    ...new Set([...sources, ...additions]),
  ];

  if (!extraSources || Array.isArray(extraSources)) {
    return append(extraSources);
  }

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
  const buildAdapter = await config.build({ cwd: getCwd() });
  const nativeExtraSources =
    additionalExtraSources ??
    (await buildAdapter.nativeBuild?.getFingerprintExtraSources?.()) ??
    [];

  return {
    ...config.fingerprint,
    extraSources: appendFingerprintExtraSources(
      config.fingerprint.extraSources,
      nativeExtraSources,
    ),
    provider: buildAdapter.nativeBuild?.fingerprint,
  };
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
  return ["**/*", "**/.build/**/*", "**/build/", "**/build*/**/*"];
}

export async function getOtaFingerprintOptions(
  platform: "ios" | "android",
  path: string,
  options: FingerprintOptions,
): Promise<OtaFingerprintOptions> {
  const { SourceSkips } = await loadExpoFingerprint(path);

  return {
    useRNCoreAutolinkingFromExpo: isExpo(path),
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
      // base paths (target CNG)
      "android/**/*",
      "ios/**/*",
      ...(options.ignorePaths ?? []),
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
    extraSources: [
      ...processExtraSources(
        resolveExtraSources(options.extraSources, platform),
        path,
      ),
      // The interface engine hashes the same contents.
      ...(options.nativeVersion === undefined
        ? []
        : [
            {
              type: "contents" as const,
              id: "nativeVersion",
              contents: String(options.nativeVersion),
              reasons: ["config"],
            },
          ]),
    ],
    debug: options.debug,
  };
}

export type FingerprintSources = {
  extraSources: string[];
};

export type FingerprintSource = NativeFingerprintSource;

export type FingerprintOptions = {
  platform: "ios" | "android";
  extraSources?: FingerprintExtraSources;
  ignorePaths?: string[];
  nativeVersion?: string | number;
  debug?: boolean;
  /**
   * The build adapter's fingerprint. Without one, `@expo/fingerprint`
   * fingerprints the project.
   */
  provider?: NativeFingerprintProvider;
};

export type FingerprintResult = NativeFingerprint;

const EXPO_FINGERPRINT = "@expo/fingerprint";

/** An engine id without its version: `@expo/fingerprint@0.20.14` → `@expo/fingerprint`. */
const engineName = (engine: string) => {
  const at = engine.lastIndexOf("@");
  return at > 0 ? engine.slice(0, at) : engine;
};

/**
 * The engines of two fingerprints when they differ. The hash then changed with
 * the engine, whether or not a native input changed. A fingerprint without a
 * recorded engine counts as `@expo/fingerprint` against another engine.
 */
export const getFingerprintEngineChange = (
  before: Pick<FingerprintResult, "engine"> | null | undefined,
  after: Pick<FingerprintResult, "engine"> | null | undefined,
): { before: string; after: string } | null => {
  if (!before || !after?.engine) return null;
  // fingerprint.json files from before engines were recorded all came from
  // @expo/fingerprint, at a version nobody recorded.
  const beforeEngine =
    before.engine ??
    (engineName(after.engine) === EXPO_FINGERPRINT ? null : EXPO_FINGERPRINT);
  return beforeEngine && beforeEngine !== after.engine
    ? { before: beforeEngine, after: after.engine }
    : null;
};

/**
 * Explains a hash that changed with its engine, for deploy, doctor, and
 * `fingerprint create`.
 */
// Engines hash sources differently, so only the previous engine can tell
// whether native inputs changed as well.
const STILL_DIFFERS =
  "If the fingerprint still differs with it, native inputs changed too, and builds you shipped need a rebuild.";

export const describeFingerprintEngineChange = (
  change: { before: string; after: string },
  label: string,
  /** `fingerprint create` already recorded the new engine's hash. */
  recorded = false,
): { message: string; resolution: string } => ({
  message: `The ${label} fingerprint changed because fingerprint.json was created with ${change.before} and the project now uses ${change.after}. Native inputs may be unchanged.`,
  resolution:
    engineName(change.before) !== engineName(change.after)
      ? `${recorded ? `fingerprint.json now records the ${change.after} hash. Rebuild` : "Run `npx hot-updater fingerprint create`, then rebuild"} the ${label} app. Builds you already shipped keep the old fingerprint and receive no updates until users install the new build.`
      : recorded
        ? `fingerprint.json now records the ${change.after} hash. To keep updating ${label} builds you already shipped, go back to ${change.before} and run \`npx hot-updater fingerprint create\` again, or restore the previous fingerprint.json. ${STILL_DIFFERS} Otherwise rebuild the ${label} app.`
        : `To keep updating ${label} builds you already shipped, go back to ${change.before}. ${STILL_DIFFERS} Otherwise run \`npx hot-updater fingerprint create\`, then rebuild the ${label} app.`,
});

type OtaFingerprintOptions = {
  useRNCoreAutolinkingFromExpo: boolean;
  platforms: Array<"ios" | "android">;
  ignorePaths: string[];
  sourceSkips: number;
  extraSources: (
    | ReturnType<typeof processExtraSources>[number]
    | { type: "contents"; id: string; contents: string; reasons: string[] }
  )[];
  debug?: boolean;
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
