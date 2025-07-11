import type { ApplePlatform } from "./platformSupport";

/**
 * Device type for Xcode destinations
 */
export type DeviceType = "device" | "simulator";

/**
 * Destination information for a platform
 */
export interface DestinationInfo {
  /** Destination string for physical devices */
  device: string;
  /** Destination string for simulators */
  simulator: string;
}

/**
 * Generic destinations for each Apple platform
 */
export const genericDestinations = {
  ios: {
    device: "generic/platform=iOS",
    simulator: "generic/platform=iOS Simulator",
  },
  macos: {
    device: "generic/platform=macOS",
    simulator: "generic/platform=macOS",
  },
  visionos: {
    device: "generic/platform=visionOS",
    simulator: "generic/platform=visionOS Simulator",
  },
  tvos: {
    device: "generic/platform=tvOS",
    simulator: "generic/platform=tvOS Simulator",
  },
} as const satisfies Record<ApplePlatform, DestinationInfo>;

/**
 * Gets the generic destination string for a platform and device type
 * @param platform - The Apple platform
 * @param deviceType - Type of device (device or simulator)
 * @returns Xcode destination string
 * 
 * @example
 * ```typescript
 * const destination = getGenericDestination("ios", "device");
 * console.log(destination); // "generic/platform=iOS"
 * ```
 */
export const getGenericDestination = (
  platform: ApplePlatform,
  deviceType: DeviceType
): string => {
  return genericDestinations[platform][deviceType];
};

/**
 * Builds a specific device destination string
 * @param deviceId - Device UDID or name
 * @returns Xcode destination string for the specific device
 * 
 * @example
 * ```typescript
 * const destination = buildDeviceDestination("iPhone 15 Pro");
 * console.log(destination); // "platform=iOS,name=iPhone 15 Pro"
 * ```
 */
export const buildDeviceDestination = (deviceId: string): string => {
  // If it's a UDID (long hex string), use id parameter
  if (deviceId.length === 40 && /^[a-fA-F0-9]+$/.test(deviceId)) {
    return `platform=iOS,id=${deviceId}`;
  }
  // Otherwise use name parameter
  return `platform=iOS,name=${deviceId}`;
};

/**
 * Builds a simulator destination string
 * @param simulatorId - Simulator UDID or name
 * @returns Xcode destination string for the simulator
 * 
 * @example
 * ```typescript
 * const destination = buildSimulatorDestination("iPhone 15 Pro Simulator");
 * console.log(destination); // "platform=iOS Simulator,name=iPhone 15 Pro Simulator"
 * ```
 */
export const buildSimulatorDestination = (simulatorId: string): string => {
  // If it's a UDID, use id parameter
  if (simulatorId.length === 36 && simulatorId.includes("-")) {
    return `platform=iOS Simulator,id=${simulatorId}`;
  }
  // Otherwise use name parameter
  return `platform=iOS Simulator,name=${simulatorId}`;
};