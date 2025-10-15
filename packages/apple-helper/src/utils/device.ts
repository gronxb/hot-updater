import os from "node:os";
import * as p from "@clack/prompts";
import type { ApplePlatform } from "@hot-updater/plugin-core";
import { execa } from "execa";
import fs from "fs";
import path from "path";
import type {
  AppleDevice,
  AppleDeviceType,
  DevicectlOutput,
  DeviceState,
  SimctlOutput,
} from "../types";

/**
 * Parses devicectl output to Device array
 * @param devicectlOutput - Raw devicectl JSON output
 * @returns Array of parsed devices
 */
const parseDevicectlList = (
  devicectlOutput: DevicectlOutput[],
): AppleDevice[] => {
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
const getDevices = async (): Promise<AppleDevice[]> => {
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
 * Gets iOS simulators using simctl with JSON output
 */
const getSimulators = async (): Promise<AppleDevice[]> => {
  try {
    const { stdout } = await execa("xcrun", [
      "simctl",
      "list",
      "devices",
      "available",
      "-j",
    ]);
    const output: SimctlOutput = JSON.parse(stdout);
    return parseSimctlJson(output);
  } catch (error) {
    throw new Error(`Failed to get simulators: ${error}`);
  }
};

/**
 * Parses simctl JSON output to Device array
 */
const parseSimctlJson = (simctlOutput: SimctlOutput): AppleDevice[] => {
  const devices: AppleDevice[] = [];

  for (const [runtime, runtimeDevices] of Object.entries(
    simctlOutput.devices,
  )) {
    const osVersion = runtime
      .replace("com.apple.CoreSimulator.SimRuntime.", "")
      .replace(/-/g, " ");
    const platform = getPlatformFromOsVersion(osVersion.split(" ")[0]);

    if (!platform) continue;

    for (const device of runtimeDevices) {
      if (device.isAvailable) {
        devices.push({
          name: device.name,
          udid: device.udid,
          version: osVersion,
          platform,
          state: device.state,
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

export interface ListDeviceOptions {
  deviceType?: AppleDeviceType;
  state?: DeviceState | "all";
}

/**
 * Lists devices and simulators for a specific platform
 * @param platform - Apple platform to filter by
 * @param options - Filtering options
 * @returns Array of devices filtered by options
 */
const listDevices = async (
  platform: ApplePlatform,
  options: ListDeviceOptions = {},
): Promise<AppleDevice[]> => {
  const spinner = p.spinner();
  spinner.start(`Discovering ${platform} devices`);

  try {
    const [simulators, devices] = await Promise.all([
      getSimulators(),
      getDevices().catch(() => []),
    ]);

    let allDevices = [...simulators, ...devices].filter(
      (device) => device.platform === platform,
    );

    if (options.deviceType) {
      allDevices = allDevices.filter((d) => d.type === options.deviceType);
    }

    if (options.state && options.state !== "all") {
      allDevices = allDevices.filter((d) => d.state === options.state);
    }

    spinner.stop(`Found ${allDevices.length} ${platform} devices`);
    return allDevices;
  } catch (error) {
    spinner.stop(`Failed to discover ${platform} devices`);
    throw error;
  }
};

const matchingDevice = (
  devices: AppleDevice[],
  deviceArg: string,
  options: {
    bootedOnly?: boolean;
    deviceType?: AppleDeviceType;
  } = {},
) => {
  let filtered = [...devices];

  if (options.deviceType) {
    filtered = filtered.filter((d) => d.type === options.deviceType);
  }

  if (options.bootedOnly) {
    filtered = filtered.filter((d) => d.state === "Booted");
  }

  const byName = filtered.find((d) => d.name === deviceArg);
  if (byName) return byName;

  const byFormattedName = filtered.find(
    (d) => formatDeviceName(d) === deviceArg,
  );
  if (byFormattedName) return byFormattedName;

  const byUdid = filtered.find((d) => d.udid === deviceArg);
  if (byUdid) return byUdid;

  return undefined;
};

const formatDeviceName = (device: AppleDevice) => {
  return device.version ? `${device.name} (${device.version})` : device.name;
};

const selectTargetDevice = async ({
  platform,
  interactive,
  deviceOption,
}: {
  platform: ApplePlatform;
  deviceOption?: string | boolean;
  interactive: boolean;
}): Promise<AppleDevice | undefined> => {
  const availableDevices = await listDevices(platform);

  if (deviceOption === true && !interactive) {
    p.log.error(
      "you can't select device manually with non-interactive cli mode(without -i option).",
    );
    process.exit(1);
  }

  if (typeof deviceOption === "string") {
    const matchedDevice = matchingDevice(availableDevices, deviceOption);

    if (!matchedDevice) {
      p.log.error(
        `device '${deviceOption}' isn't included in the attached devices.`,
      );
      process.exit(1);
    }

    return matchedDevice;
  }

  if (interactive) {
    if (!availableDevices.length) {
      p.log.error("you passed -d option but there is no attached devices.");
      process.exit(1);
    }

    const device = await p.select({
      message: "Target Device",
      options: availableDevices.map((d) => ({
        value: d,
        label: `${d.name} (${d.type}) - ${d.state}`,
        hint: d.udid,
      })),
    });

    if (p.isCancel(device)) {
      process.exit(1);
    }

    return device;
  }

  const bootedDevices = await listDevices(platform, { state: "Booted" });
  if (bootedDevices.length > 0) {
    return bootedDevices[0];
  }

  return undefined;
};

export const Device = {
  listDevices,
  selectTargetDevice,
};

// TODO: Add advanced device discovery features
// - Device availability validation (check if device is ready for deployment)
// - Automatic simulator boot functionality
// - Device pairing status checking for physical devices
// - Network device discovery support
// - Device capability detection (iOS version, architecture, etc.)
