/**
 * Supported Apple platforms for building and deployment
 */
export const supportedPlatforms = {
  ios: "ios",
  macos: "macos",
  visionos: "visionos",
  tvos: "tvos",
  watchos: "watchos",
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
  /** SDK for device builds */
  deviceSdk: string;
  /** SDK for simulator builds */
  simulatorSdk: string;
  /** Whether the platform supports simulators */
  supportsSimulator: boolean;
  /** Default device destination for physical devices */
  deviceDestination: string;
  /** Default simulator destination */
  simulatorDestination: string;
}

/**
 * Platform configurations for different Apple platforms
 */
export const platformConfigs: Record<ApplePlatform, PlatformConfig> = {
  ios: {
    name: "ios",
    deviceSdk: "iphoneos",
    simulatorSdk: "iphonesimulator",
    supportsSimulator: true,
    deviceDestination: "platform=iOS",
    simulatorDestination: "platform=iOS Simulator",
  },
  macos: {
    name: "macos",
    deviceSdk: "macosx",
    simulatorSdk: "macosx",
    supportsSimulator: false,
    deviceDestination: "platform=macOS",
    simulatorDestination: "platform=macOS",
  },
  visionos: {
    name: "visionos",
    deviceSdk: "xros",
    simulatorSdk: "xrsimulator",
    supportsSimulator: true,
    deviceDestination: "platform=visionOS",
    simulatorDestination: "platform=visionOS Simulator",
  },
  tvos: {
    name: "tvos",
    deviceSdk: "appletvos",
    simulatorSdk: "appletvsimulator",
    supportsSimulator: true,
    deviceDestination: "platform=tvOS",
    simulatorDestination: "platform=tvOS Simulator",
  },
  watchos: {
    name: "watchos",
    deviceSdk: "watchos",
    simulatorSdk: "watchsimulator",
    supportsSimulator: true,
    deviceDestination: "platform=watchOS",
    simulatorDestination: "platform=watchOS Simulator",
  },
};
