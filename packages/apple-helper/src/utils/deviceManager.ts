import fs from "fs";
import os from "node:os";
import path from "path";
import * as p from "@clack/prompts";
import type { ApplePlatform } from "@hot-updater/plugin-core";
import { execa } from "execa";
import type { DeviceType } from "./destination";

export type DeviceState = "Booted" | "Shutdown";

export interface Device {
  name: string;
  udid: string;
  version: string;
  platform: ApplePlatform;
  state: DeviceState;
  type: DeviceType;
}

/**
 * devicectl list output structure
 */
interface DevicectlOutput {
  capabilities: object[];
  connectionProperties: object;
  deviceProperties: {
    bootedFromSnapshot: boolean;
    bootedSnapshotName: string;
    ddiServicesAvailable: boolean;
    developerModeStatus: string;
    hasInternalOSBuild: boolean;
    name: string;
    osBuildUpdate: string;
    osVersionNumber: string;
    rootFileSystemIsWritable: boolean;
    bootState?: string;
    screenViewingURL?: string;
  };
  hardwareProperties: {
    cpuType: object;
    deviceType: string;
    ecid: number;
    hardwareModel: string;
    internalStorageCapacity: number;
    isProductionFused: boolean;
    marketingName: string;
    platform: string;
    productType: string;
    reality: string;
    serialNumber: string;
    supportedCPUTypes: object[];
    supportedDeviceFamilies: number[];
    thinningProductType: string;
    udid: string;
  };
  identifier: string;
  tags: unknown[];
  visibilityClass: string;
}

/**
 * Parses devicectl output to Device array
 * @param devicectlOutput - Raw devicectl JSON output
 * @returns Array of parsed devices
 */
const parseDevicectlList = (devicectlOutput: DevicectlOutput[]): Device[] => {
  return devicectlOutput.map((device) => ({
    name: device.deviceProperties.name,
    udid: device.hardwareProperties.udid,
    version: `${device.hardwareProperties.platform} ${device.deviceProperties.osVersionNumber}`,
    platform: getPlatformFromOsVersion(device.hardwareProperties.platform),
    state:
      device.deviceProperties.bootState === "booted" ? "Booted" : "Shutdown",
    type: "device",
  }));
};

/**
 * Gets physical iOS devices using devicectl
 */
const getDevices = async (): Promise<Device[]> => {
  const tmpPath = path.resolve(os.tmpdir(), "iosPhysicalDevices.json");

  try {
    await execa("xcrun", ["devicectl", "list", "devices", "-j", tmpPath]);
    const output = JSON.parse(fs.readFileSync(tmpPath, "utf8"));
    return parseDevicectlList(output.result.devices);
  } catch (error) {
    throw new Error(`Failed to get devices: ${error}`);
  }
};

/**
 * Gets iOS simulators using simctl
 */
const getSimulators = async (): Promise<Device[]> => {
  try {
    const { stdout } = await execa("xcrun", [
      "simctl",
      "list",
      "devices",
      "available",
    ]);
    return parseSimctlOutput(stdout);
  } catch (error) {
    throw new Error(`Failed to get simulators: ${error}`);
  }
};

/**
 * Parses simctl output to Device array
 */
const parseSimctlOutput = (input: string): Device[] => {
  const lines = input.split("\\n");
  const devices: Device[] = [];
  const currentOSIdx = 1;
  const deviceNameIdx = 1;
  const identifierIdx = 4;
  const deviceStateIdx = 5;
  let osVersion = "";

  for (const line of lines) {
    const currentOsMatch = line.match(/-- (.*?) --/);
    if (currentOsMatch && currentOsMatch.length > 0) {
      osVersion = currentOsMatch[currentOSIdx];
    }

    const deviceMatch = line.match(
      /(.*?) (\\(([0-9.]+)\\) )?\\(([0-9A-F-]+)\\) \\((.*?)\\)/,
    );
    if (deviceMatch && deviceMatch.length > 0) {
      const platform = getPlatformFromOsVersion(osVersion.split(" ")[0]);
      if (platform) {
        devices.push({
          name: deviceMatch[deviceNameIdx].trim(),
          udid: deviceMatch[identifierIdx],
          version: osVersion,
          platform,
          state: deviceMatch[deviceStateIdx] as DeviceState,
          type: "simulator",
        });
      }
    }
  }

  return devices;
};

/**
 * Maps OS version string to Apple platform
 * @param osVersion - OS version string from devicectl/simctl
 * @returns Apple platform or undefined if unknown
 */
const getPlatformFromOsVersion = (osVersion: string): ApplePlatform => {
  switch (osVersion) {
    case "iOS":
      return "ios";
    // case "tvOS":
    //   return "tvos";
    // case "macOS":
    //   return "macos";
    // case "xrOS":
    // case "visionOS":
    //   return "visionos";
    default:
      return "ios"; // Default fallback
  }
};

/**
 * Lists all devices and simulators for a specific platform
 * @param platform - Apple platform to filter by
 * @returns Array of devices and simulators for the platform
 *
 * @example
 * ```typescript
 * const devices = await listDevicesAndSimulators("ios");
 * console.log(devices.length); // Number of iOS devices + simulators
 * ```
 */
export const listDevicesAndSimulators = async (
  platform: ApplePlatform,
): Promise<Device[]> => {
  const spinner = p.spinner();
  spinner.start(`Discovering ${platform} devices and simulators`);

  try {
    const [simulators, devices] = await Promise.all([
      getSimulators(),
      getDevices().catch(() => []), // Gracefully handle devicectl failures
    ]);

    const filtered = [...simulators, ...devices].filter(
      (device) => device.platform === platform,
    );

    spinner.stop(`Found ${filtered.length} ${platform} devices and simulators`);
    return filtered;
  } catch (error) {
    spinner.stop(`Failed to discover ${platform} devices`);
    throw error;
  }
};

/**
 * Lists only physical devices for a platform
 */
export const listDevices = async (
  platform: ApplePlatform,
): Promise<Device[]> => {
  const devices = await getDevices();
  return devices.filter((device) => device.platform === platform);
};

/**
 * Lists only simulators for a platform
 */
export const listSimulators = async (
  platform: ApplePlatform,
): Promise<Device[]> => {
  const simulators = await getSimulators();
  return simulators.filter((device) => device.platform === platform);
};

/**
 * Finds available (booted or shutdown) devices for a platform
 */
export const listAvailableDevices = async (
  platform: ApplePlatform,
): Promise<Device[]> => {
  const allDevices = await listDevicesAndSimulators(platform);
  return allDevices.filter(
    (device) => device.state === "Booted" || device.state === "Shutdown",
  );
};

/**
 * Finds booted devices for a platform
 */
export const listBootedDevices = async (
  platform: ApplePlatform,
): Promise<Device[]> => {
  const allDevices = await listDevicesAndSimulators(platform);
  return allDevices.filter((device) => device.state === "Booted");
};

/**
 * Prompts user to select a device from available devices
 */
export const selectDevice = async (
  platform: ApplePlatform,
  deviceType?: DeviceType,
): Promise<Device | undefined> => {
  const devices = await listAvailableDevices(platform);
  const filtered = deviceType
    ? devices.filter((device) => device.type === deviceType)
    : devices;

  if (filtered.length === 0) {
    p.log.warn(`No ${deviceType || ""} devices found for ${platform}`);
    return undefined;
  }

  if (filtered.length === 1) {
    return filtered[0];
  }

  const selected = await p.select({
    message: `Select a ${platform} ${deviceType || "device"}:`,
    options: filtered.map((device) => ({
      value: device,
      label: `${device.name} (${device.type}) - ${device.state}`,
      hint: device.udid,
    })),
  });

  return p.isCancel(selected) ? undefined : selected;
};

/**
 * Checks if a device is available for deployment
 * @param device - Device to check
 * @returns true if device is available (Booted or Shutdown)
 */
export const isDeviceAvailable = (device: Device) => {
  return device.state === "Booted" || device.state === "Shutdown";
};

// TODO: Add advanced device discovery features
// - Device availability validation (check if device is ready for deployment)
// - Automatic simulator boot functionality
// - Device pairing status checking for physical devices
// - Network device discovery support
// - Device capability detection (iOS version, architecture, etc.)
