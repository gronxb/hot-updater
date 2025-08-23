import type { DeviceType } from "../utils/destination";
import type { Device } from "../utils/deviceManager";

/**
 * Device matching options
 */
export interface DeviceMatchOptions {
  /** Only match booted devices/simulators */
  bootedOnly?: boolean;
  /** Only match specific device type */
  deviceType?: DeviceType;
  /** Prefer devices to simulators */
  preferDevices?: boolean;
  /** Prefer simulators to devices */
  preferSimulators?: boolean;
}

/**
 * Device matcher utility for finding devices by various criteria
 */
export class DeviceMatcher {
  private readonly devices: Device[];

  /**
   * Creates a new DeviceMatcher instance
   * @param devices - Array of available devices
   */
  constructor(devices: Device[]) {
    this.devices = devices;
  }

  /**
   * Finds a device by name or UDID
   * @param deviceArg - Device name or UDID to search for
   * @param options - Matching options
   * @returns Matching device or undefined
   *
   * @example
   * ```typescript
   * const matcher = new DeviceMatcher(devices);
   * const device = matcher.findDevice("iPhone 15 Pro");
   * const deviceByUdid = matcher.findDevice("12345678-1234-1234-1234-123456789ABC");
   * ```
   */
  findDevice(
    deviceArg: string,
    options: DeviceMatchOptions = {},
  ): Device | undefined {
    const filteredDevices = this.filterDevices(options);

    // Try exact name match first
    const deviceByName = filteredDevices.find(
      (device) => device.name === deviceArg,
    );
    if (deviceByName) return deviceByName;

    // Try formatted name match (includes version info)
    const deviceByFormattedName = filteredDevices.find(
      (device) => this.formatDeviceName(device) === deviceArg,
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
  }

  /**
   * Finds multiple devices matching criteria
   * @param deviceArg - Device name pattern or UDID
   * @param options - Matching options
   * @returns Array of matching devices
   *
   * @example
   * ```typescript
   * const matcher = new DeviceMatcher(devices);
   * const iphones = matcher.findDevices("iPhone", { deviceType: "simulator" });
   * ```
   */
  findDevices(deviceArg: string, options: DeviceMatchOptions = {}): Device[] {
    const filteredDevices = this.filterDevices(options);

    return filteredDevices.filter(
      (device) =>
        device.name.toLowerCase().includes(deviceArg.toLowerCase()) ||
        this.formatDeviceName(device)
          .toLowerCase()
          .includes(deviceArg.toLowerCase()) ||
        device.udid === deviceArg,
    );
  }

  /**
   * Gets the best matching device based on preferences
   * @param deviceArg - Device name or UDID
   * @param options - Matching options with preferences
   * @returns Best matching device or undefined
   *
   * @example
   * ```typescript
   * const matcher = new DeviceMatcher(devices);
   * const device = matcher.getBestMatch("iPhone 15", {
   *   preferDevices: true,
   *   bootedOnly: true
   * });
   * ```
   */
  getBestMatch(
    deviceArg: string,
    options: DeviceMatchOptions = {},
  ): Device | undefined {
    const matches = this.findDevices(deviceArg, options);

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

    // Return first available device
    return matches[0];
  }

  /**
   * Formats device name with version information
   * @param device - Device to format
   * @returns Formatted device name
   *
   * @example
   * ```typescript
   * const formatted = matcher.formatDeviceName(device);
   * console.log(formatted); // "iPhone 15 Pro (iOS 17.0)"
   * ```
   */
  formatDeviceName(device: Device): string {
    return device.version ? `${device.name} (${device.version})` : device.name;
  }

  /**
   * Gets all available devices
   * @param options - Filtering options
   * @returns Array of filtered devices
   */
  getAvailableDevices(options: DeviceMatchOptions = {}): Device[] {
    return this.filterDevices(options);
  }

  /**
   * Gets devices by type
   * @param deviceType - Type of devices to get
   * @returns Array of devices of specified type
   */
  getDevicesByType(deviceType: DeviceType): Device[] {
    return this.devices.filter((device) => device.type === deviceType);
  }

  /**
   * Gets booted devices
   * @param deviceType - Optional device type filter
   * @returns Array of booted devices
   */
  getBootedDevices(deviceType?: DeviceType): Device[] {
    return this.devices.filter(
      (device) =>
        device.state === "Booted" &&
        (!deviceType || device.type === deviceType),
    );
  }

  /**
   * Filters devices based on options
   * @param options - Filtering options
   * @returns Filtered array of devices
   */
  private filterDevices(options: DeviceMatchOptions): Device[] {
    let filtered = [...this.devices];

    if (options.deviceType) {
      filtered = filtered.filter(
        (device) => device.type === options.deviceType,
      );
    }

    if (options.bootedOnly) {
      filtered = filtered.filter((device) => device.state === "Booted");
    }

    return filtered;
  }
}

/**
 * Creates a new DeviceMatcher instance
 * @param devices - Array of available devices
 * @returns New DeviceMatcher instance
 */
export const createDeviceMatcher = (devices: Device[]): DeviceMatcher => {
  return new DeviceMatcher(devices);
};

/**
 * Quick utility function to find a matching device
 * @param devices - Array of devices to search
 * @param deviceArg - Device name or UDID
 * @param options - Matching options
 * @returns Matching device or undefined
 */
export const matchingDevice = (
  devices: Device[],
  deviceArg: string,
  options: DeviceMatchOptions = {},
): Device | undefined => {
  const matcher = createDeviceMatcher(devices);
  return matcher.findDevice(deviceArg, options);
};

/**
 * Formats a device name with version information
 * @param device - Device to format
 * @returns Formatted device name string
 */
export const formattedDeviceName = (device: Device): string => {
  return device.version ? `${device.name} (${device.version})` : device.name;
};
