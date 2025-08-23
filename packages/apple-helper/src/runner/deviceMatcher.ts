import type { DeviceType } from "../utils/destination";
import type { Device } from "../utils/deviceManager";

export interface DeviceMatchOptions {
  bootedOnly?: boolean;
  deviceType?: DeviceType;
  preferDevices?: boolean;
  preferSimulators?: boolean;
}

export const findDevice = (
  devices: Device[],
  deviceArg: string,
  options: DeviceMatchOptions = {},
) => {
  const filteredDevices = filterDevices(devices, options);

  // Try exact name match first
  const deviceByName = filteredDevices.find(
    (device) => device.name === deviceArg,
  );
  if (deviceByName) return deviceByName;

  // Try formatted name match (includes version info)
  const deviceByFormattedName = filteredDevices.find(
    (device) => formatDeviceName(device) === deviceArg,
  );
  if (deviceByFormattedName) return deviceByFormattedName;

  // Try UDID match
  const deviceByUdid = filteredDevices.find(
    (device) => device.udid === deviceArg,
  );
  if (deviceByUdid) return deviceByUdid;

  // Try partial name match (case insensitive)
  return filteredDevices.find((device) =>
    device.name.toLowerCase().includes(deviceArg.toLowerCase()),
  );
};

export const findDevices = (
  devices: Device[],
  deviceArg: string,
  options: DeviceMatchOptions = {},
) => {
  const filteredDevices = filterDevices(devices, options);

  return filteredDevices.filter(
    (device) =>
      device.name.toLowerCase().includes(deviceArg.toLowerCase()) ||
      formatDeviceName(device)
        .toLowerCase()
        .includes(deviceArg.toLowerCase()) ||
      device.udid === deviceArg,
  );
};

export const getBestMatch = (
  devices: Device[],
  deviceArg: string,
  options: DeviceMatchOptions = {},
) => {
  const matches = findDevices(devices, deviceArg, options);

  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  // Apply preferences
  if (options.preferDevices) {
    const physicalDevices = matches.filter((d) => d.type === "device");
    if (physicalDevices.length > 0) return physicalDevices[0];
  }

  if (options.preferSimulators) {
    const simulators = matches.filter((d) => d.type === "simulator");
    if (simulators.length > 0) return simulators[0];
  }

  // Prefer booted devices
  const bootedDevices = matches.filter((d) => d.state === "Booted");
  if (bootedDevices.length > 0) return bootedDevices[0];

  return matches[0];
};

export const formatDeviceName = (device: Device) => {
  return device.version ? `${device.name} (${device.version})` : device.name;
};

const filterDevices = (devices: Device[], options: DeviceMatchOptions) => {
  let filtered = [...devices];

  if (options.deviceType) {
    filtered = filtered.filter((device) => device.type === options.deviceType);
  }

  if (options.bootedOnly) {
    filtered = filtered.filter((device) => device.state === "Booted");
  }

  return filtered;
};

export const matchingDevice = (
  devices: Device[],
  deviceArg: string,
  options: DeviceMatchOptions = {},
) => {
  return findDevice(devices, deviceArg, options);
};
