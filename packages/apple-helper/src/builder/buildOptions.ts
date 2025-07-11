import type { ApplePlatform } from "../utils/platformSupport";

/**
 * Build flags for Apple platform builds
 */
export interface BuildFlags {
  /** Enable verbose logging */
  verbose: boolean;
  /** Xcode configuration to use (Debug, Release) */
  configuration: string;
  /** Xcode scheme to build */
  scheme: string;
  /** Specific target to build */
  target?: string;
  /** Additional parameters passed to xcodebuild */
  extraParams?: string[];
  /** Additional parameters for exportArchive */
  exportExtraParams?: string[];
  /** Path to ExportOptions.plist file */
  exportOptionsPlist?: string;
  /** Custom build folder (derivedDataPath) */
  buildFolder?: string;
  /** Build destinations (simulator, device, or xcodebuild format) */
  destination?: string[];
  /** Create archive for App Store distribution */
  archive: boolean;
  /** Automatically install CocoaPods dependencies */
  installPods: boolean;
}

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

/**
 * Archive options
 */
export interface ArchiveOptions {
  /** Xcode scheme to archive */
  scheme: string;
  /** Build configuration */
  buildConfiguration: string;
  /** Platform to build for */
  platform: ApplePlatform;
  /** SDK to use for building */
  sdk?: string;
  /** Build destinations */
  destination?: string;
  /** Path to xcconfig file */
  xcconfig?: string;
  /** Additional xcodebuild parameters */
  extraParams?: string[];
  /** Custom build folder */
  buildFolder?: string;
}

/**
 * Export archive options
 */
export interface ExportOptions {
  /** Path to the archive to export */
  archivePath: string;
  /** Path to ExportOptions.plist file */
  exportOptionsPlist: string;
  /** Additional export parameters */
  exportExtraParams?: string[];
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
  isSimulator: boolean = false
): string => {
  const destination = isSimulator ? "simulator" : "device";
  return sdkMappings[platform][destination];
};

/**
 * Default build configurations
 */
export const defaultBuildConfig = {
  configuration: "Release",
  scheme: "Release",
  verbose: false,
  installPods: true,
  archive: false,
} as const;

/**
 * Validates build options and fills in defaults
 * @param options - Partial build options
 * @returns Complete build options with defaults applied
 */
export const validateBuildOptions = (options: Partial<BuildFlags>): BuildFlags => {
  return {
    ...defaultBuildConfig,
    ...options,
  };
};