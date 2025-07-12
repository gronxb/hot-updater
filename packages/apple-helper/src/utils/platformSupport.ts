/**
 * Supported Apple platforms for building and deployment
 */
export const supportedPlatforms = {
  ios: "ios",
  macos: "macos",
  visionos: "visionos",
  tvos: "tvos",
} as const;

/**
 * Type representing a supported Apple platform
 */
export type ApplePlatform =
  (typeof supportedPlatforms)[keyof typeof supportedPlatforms];

/**
 * Platform configuration for builds
 */
export interface PlatformConfig {
  /** Platform name */
  name: ApplePlatform;
  /** Default SDK to use for building */
  defaultSdk: string;
  /** Whether the platform supports simulators */
  supportsSimulator: boolean;
  /** Default device destination for physical devices */
  deviceDestination: string;
  /** Default simulator destination */
  simulatorDestination?: string;
}

/**
 * Platform configurations for different Apple platforms
 */
export const platformConfigs: Record<ApplePlatform, PlatformConfig> = {
  ios: {
    name: "ios",
    defaultSdk: "iphoneos",
    supportsSimulator: true,
    deviceDestination: "generic/platform=iOS",
    simulatorDestination: "generic/platform=iOS Simulator",
  },
  macos: {
    name: "macos",
    defaultSdk: "macosx",
    supportsSimulator: false,
    deviceDestination: "generic/platform=macOS",
  },
  visionos: {
    name: "visionos",
    defaultSdk: "xros",
    supportsSimulator: true,
    deviceDestination: "generic/platform=visionOS",
    simulatorDestination: "generic/platform=visionOS Simulator",
  },
  tvos: {
    name: "tvos",
    defaultSdk: "appletvos",
    supportsSimulator: true,
    deviceDestination: "generic/platform=tvOS",
    simulatorDestination: "generic/platform=tvOS Simulator",
  },
};

/**
 * Checks if a platform is supported
 * @param platform - Platform name to check
 * @returns True if platform is supported
 */
export const isSupportedPlatform = (
  platform: string,
): platform is ApplePlatform => {
  return Object.values(supportedPlatforms).includes(platform as ApplePlatform);
};

/**
 * Gets platform configuration for a given platform
 * @param platform - Platform name
 * @returns Platform configuration
 * @throws Error if platform is not supported
 */
export const getPlatformConfig = (platform: string): PlatformConfig => {
  if (!isSupportedPlatform(platform)) {
    throw new Error(
      `Unsupported platform: ${platform}. Supported platforms: ${Object.values(supportedPlatforms).join(", ")}`,
    );
  }
  return platformConfigs[platform];
};
