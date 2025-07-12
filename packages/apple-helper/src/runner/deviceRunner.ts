import { execa } from "execa";
import * as p from "@clack/prompts";
import type { Device } from "../utils/deviceManager";

/**
 * Options for device operations
 */
export interface DeviceRunnerOptions {
  /** Source directory for operation context */
  sourceDir?: string;
  /** Whether to launch app after installation */
  launch?: boolean;
  /** Bundle ID for launching (if different from installed app) */
  bundleId?: string;
}

/**
 * Device runner for physical iOS devices
 */
export class DeviceRunner {
  private device: Device;

  /**
   * Creates a new DeviceRunner instance
   * @param device - Target device information
   */
  constructor(device: Device) {
    this.device = device;
  }

  /**
   * Installs and optionally launches an app on a physical device
   * @param appPath - Path to the .app bundle
   * @param options - Installation and launch options
   *
   * @example
   * ```typescript
   * const runner = new DeviceRunner(device);
   * await runner.installAndLaunch("/path/to/MyApp.app", {
   *   launch: true,
   *   sourceDir: "./ios"
   * });
   * ```
   */
  async installAndLaunch(
    appPath: string,
    options: DeviceRunnerOptions = {},
  ): Promise<void> {
    await this.install(appPath, options);

    if (options.launch !== false) {
      await this.launch(
        options.bundleId || (await this.extractBundleId(appPath)),
        options,
      );
    }
  }

  /**
   * Installs an app on the device
   * @param appPath - Path to the .app bundle
   * @param options - Installation options
   *
   * @example
   * ```typescript
   * const runner = new DeviceRunner(device);
   * await runner.install("/path/to/MyApp.app");
   * ```
   */
  async install(
    appPath: string,
    options: DeviceRunnerOptions = {},
  ): Promise<void> {
    const deviceCtlArgs = [
      "devicectl",
      "device",
      "install",
      "app",
      "--device",
      this.device.udid,
      appPath,
    ];

    const spinner = p.spinner();
    spinner.start(`Installing app on ${this.device.name}`);

    try {
      await execa("xcrun", deviceCtlArgs, {
        cwd: options.sourceDir,
      });
      spinner.stop(`Successfully installed app on ${this.device.name}`);
    } catch (error) {
      spinner.stop(`Failed to install app on ${this.device.name}`);
      throw new Error(
        `Failed to install the app on ${this.device.name}: ${error}`,
      );
    }
  }

  /**
   * Launches an app on the device by bundle ID
   * @param bundleId - App bundle identifier
   * @param options - Launch options
   *
   * @example
   * ```typescript
   * const runner = new DeviceRunner(device);
   * await runner.launch("com.example.myapp");
   * ```
   */
  async launch(
    bundleId: string,
    options: DeviceRunnerOptions = {},
  ): Promise<void> {
    const deviceCtlArgs = [
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      this.device.udid,
      bundleId,
    ];

    const spinner = p.spinner();
    spinner.start(`Launching app on ${this.device.name}`);

    try {
      await execa("xcrun", deviceCtlArgs, {
        cwd: options.sourceDir,
      });
      spinner.stop(`Successfully launched app on ${this.device.name}`);
    } catch (error) {
      spinner.stop(`Failed to launch app on ${this.device.name}`);
      throw new Error(
        `Failed to launch the app on ${this.device.name}: ${error}`,
      );
    }
  }

  /**
   * Uninstalls an app from the device
   * @param bundleId - App bundle identifier to uninstall
   * @param options - Uninstall options
   *
   * @example
   * ```typescript
   * const runner = new DeviceRunner(device);
   * await runner.uninstall("com.example.myapp");
   * ```
   */
  async uninstall(
    bundleId: string,
    options: DeviceRunnerOptions = {},
  ): Promise<void> {
    const deviceCtlArgs = [
      "devicectl",
      "device",
      "uninstall",
      "app",
      "--device",
      this.device.udid,
      bundleId,
    ];

    const spinner = p.spinner();
    spinner.start(`Uninstalling app from ${this.device.name}`);

    try {
      await execa("xcrun", deviceCtlArgs, {
        cwd: options.sourceDir,
      });
      spinner.stop(`Successfully uninstalled app from ${this.device.name}`);
    } catch (error) {
      spinner.stop(`Failed to uninstall app from ${this.device.name}`);
      throw new Error(
        `Failed to uninstall the app from ${this.device.name}: ${error}`,
      );
    }
  }

  /**
   * Extracts bundle ID from Info.plist in the app bundle
   * @param appPath - Path to the .app bundle
   * @returns Bundle identifier string
   */
  private async extractBundleId(appPath: string): Promise<string> {
    try {
      const { stdout } = await execa("/usr/libexec/PlistBuddy", [
        "-c",
        "Print:CFBundleIdentifier",
        `${appPath}/Info.plist`,
      ]);
      return stdout.trim();
    } catch (error) {
      throw new Error(`Failed to extract bundle ID from ${appPath}: ${error}`);
    }
  }

  /**
   * Gets device information
   * @returns Device information
   */
  getDevice(): Device {
    return this.device;
  }

  /**
   * Checks if device is available for operations
   * @returns True if device is available
   */
  isDeviceAvailable(): boolean {
    return this.device.state === "Booted" || this.device.state === "Shutdown";
  }
}

/**
 * Creates a new DeviceRunner instance
 * @param device - Target device information
 * @returns New DeviceRunner instance
 */
export const createDeviceRunner = (device: Device): DeviceRunner => {
  return new DeviceRunner(device);
};

// TODO: Add advanced device runner features
// - App process monitoring and logging
// - Crash detection and reporting
// - Performance metrics collection during app runtime
// - Network debugging support for device apps
// - Automatic device unlock/pairing verification before operations
