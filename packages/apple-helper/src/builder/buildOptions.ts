import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";
import type { ApplePlatform } from "../utils/platform";

/**
 * Build result information
 */
export interface BuildResult {
  /** Path to the built app (.app file) */
  appPath: string;
  /** Path to the Info.plist file */
  infoPlistPath: string;
  /** Archive path (if archive was created) */
  archivePath?: string;
  /** Export path (if IPA was exported) */
  exportPath?: string;
  /** Scheme used for building */
  scheme: string;
  /** Configuration used for building */
  configuration: string;
}

export interface ArchiveOptions {
  schemeConfig: NativeBuildIosScheme;
  platform: ApplePlatform;
  outputPath: string;
}

export interface ExportOptions {
  schemeConfig: NativeBuildIosScheme;
  archivePath: string;
  exportPath: string;
}

/**
 * SDK mappings for different platforms and destinations
 */
export const sdkMappings = {
  ios: {
    simulator: "iphonesimulator",
    device: "iphoneos",
  },
  macos: {
    simulator: "macosx",
    device: "macosx",
  },
  tvos: {
    simulator: "appletvsimulator",
    device: "appletvos",
  },
  visionos: {
    simulator: "xrsimulator",
    device: "xros",
  },
} as const;

/**
 * Gets the appropriate SDK for a platform and destination type
 * @param platform - Apple platform
 * @param isSimulator - Whether building for simulator
 * @returns SDK string for xcodebuild
 */
export const getSdkForPlatform = (
  platform: ApplePlatform,
  isSimulator = false,
): string => {
  const destination = isSimulator ? "simulator" : "device";
  return sdkMappings[platform][destination];
};

/**
 * Validates build options and fills in defaults
 * @param options - Partial build options
 * @returns Complete build options with defaults applied
 */
export const enrichIosNativeBuildSchemeOptions = (
  options: Partial<BuildFlags>,
): BuildFlags => {
  return {
    configuration: "Release",
    scheme: "Release",
    verbose: false,
    installPods: true,
    ...options,
  };
};
