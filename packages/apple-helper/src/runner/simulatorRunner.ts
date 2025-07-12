import path from "node:path";
import * as p from "@clack/prompts";
import { execa } from "execa";
import type { Device } from "../utils/deviceManager";
import { readKeyFromPlist } from "../utils/plistManager";

/**
 * Options for simulator operations
 */
export interface SimulatorRunnerOptions {
  /** Source directory for operation context */
  sourceDir?: string;
  /** Whether to launch app after installation */
  launch?: boolean;
  /** Bundle ID for launching (if different from installed app) */
  bundleId?: string;
  /** Path to Info.plist file */
  infoPlistPath?: string;
}

/**
 * Simulator runner for iOS simulators
 */
export class SimulatorRunner {
  private device: Device;

  /**
   * Creates a new SimulatorRunner instance
   * @param device - Target simulator information
   */
  constructor(device: Device) {
    if (device.type !== "simulator") {
      throw new Error("Device must be a simulator");
    }
    this.device = device;
  }

  /**
   * Installs and launches an app on the simulator
   * @param appPath - Path to the .app bundle
   * @param options - Installation and launch options
   *
   * @example
   * ```typescript
   * const runner = new SimulatorRunner(simulator);
   * await runner.installAndLaunch("/path/to/MyApp.app", {
   *   launch: true,
   *   infoPlistPath: "/path/to/Info.plist"
   * });
   * ```
   */
  async installAndLaunch(
    appPath: string,
    options: SimulatorRunnerOptions = {},
  ): Promise<void> {
    // Ensure simulator is booted and visible
    await this.launchSimulator();

    // Install the app
    await this.install(appPath, options);

    // Launch the app if requested
    if (options.launch !== false) {
      const bundleId =
        options.bundleId ||
        (await this.extractBundleId(appPath, options.infoPlistPath));
      await this.launch(bundleId, options);
    }
  }

  /**
   * Launches Simulator.app and boots the simulator if needed
   *
   * @example
   * ```typescript
   * const runner = new SimulatorRunner(simulator);
   * await runner.launchSimulator();
   * ```
   */
  async launchSimulator(): Promise<void> {
    if (this.device.type !== "simulator") {
      return;
    }

    /**
     * Booting simulator through `xcrun simctl boot` will boot it in headless mode.
     * To show the simulator to the user, we need to launch Simulator.app.
     * We pass `-CurrentDeviceUDID` so it opens with the correct device.
     */
    const { stdout: activeDeveloperDir } = await execa("xcode-select", ["-p"]);

    await execa("open", [
      `${activeDeveloperDir}/Applications/Simulator.app`,
      "--args",
      "-CurrentDeviceUDID",
      this.device.udid,
    ]);

    // Boot simulator if it's not already booted
    if (this.device.state !== "Booted") {
      await this.bootSimulator();
    }
  }

  /**
   * Installs an app on the simulator
   * @param appPath - Path to the .app bundle
   * @param options - Installation options
   *
   * @example
   * ```typescript
   * const runner = new SimulatorRunner(simulator);
   * await runner.install("/path/to/MyApp.app");
   * ```
   */
  async install(
    appPath: string,
    options: SimulatorRunnerOptions = {},
  ): Promise<void> {
    const spinner = p.spinner();
    spinner.start(`Installing app on "${this.device.name}"`);

    try {
      await execa("xcrun", ["simctl", "install", this.device.udid, appPath], {
        cwd: options.sourceDir,
      });
      spinner.stop(`Successfully installed app on "${this.device.name}"`);
    } catch (error) {
      spinner.stop(`Failed to install app on "${this.device.name}"`);
      throw new Error(`Failed to install the app on simulator: ${error}`);
    }
  }

  /**
   * Launches an app on the simulator
   * @param bundleId - App bundle identifier
   * @param options - Launch options
   *
   * @example
   * ```typescript
   * const runner = new SimulatorRunner(simulator);
   * await runner.launch("com.example.myapp");
   * ```
   */
  async launch(
    bundleId: string,
    options: SimulatorRunnerOptions = {},
  ): Promise<void> {
    const spinner = p.spinner();
    spinner.start(`Launching app on "${this.device.name}"`);

    try {
      await execa("xcrun", ["simctl", "launch", this.device.udid, bundleId], {
        cwd: options.sourceDir,
      });
      spinner.stop(`Successfully launched app on "${this.device.name}"`);
    } catch (error) {
      spinner.stop(`Failed to launch app on "${this.device.name}"`);
      throw new Error(`Failed to launch the app on simulator: ${error}`);
    }
  }

  /**
   * Uninstalls an app from the simulator
   * @param bundleId - App bundle identifier to uninstall
   * @param options - Uninstall options
   *
   * @example
   * ```typescript
   * const runner = new SimulatorRunner(simulator);
   * await runner.uninstall("com.example.myapp");
   * ```
   */
  async uninstall(
    bundleId: string,
    options: SimulatorRunnerOptions = {},
  ): Promise<void> {
    const spinner = p.spinner();
    spinner.start(`Uninstalling app from "${this.device.name}"`);

    try {
      await execa(
        "xcrun",
        ["simctl", "uninstall", this.device.udid, bundleId],
        {
          cwd: options.sourceDir,
        },
      );
      spinner.stop(`Successfully uninstalled app from "${this.device.name}"`);
    } catch (error) {
      spinner.stop(`Failed to uninstall app from "${this.device.name}"`);
      throw new Error(`Failed to uninstall the app from simulator: ${error}`);
    }
  }

  /**
   * Boots the simulator if it's not already booted
   */
  private async bootSimulator(): Promise<void> {
    try {
      await execa("xcrun", ["simctl", "boot", this.device.udid]);
    } catch (error) {
      // Handle case where simulator is already booted but state shows as Shutdown
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("Unable to boot device in current state: Booted")
      ) {
        p.log.info(`Simulator ${this.device.udid} already booted. Skipping.`);
        return;
      }
      throw new Error(`Failed to boot simulator: ${error}`);
    }
  }

  /**
   * Extracts bundle ID from Info.plist
   * @param appPath - Path to the .app bundle
   * @param infoPlistPath - Optional explicit path to Info.plist
   * @returns Bundle identifier string
   */
  private async extractBundleId(
    appPath: string,
    infoPlistPath?: string,
  ): Promise<string> {
    const plistPath = infoPlistPath || path.join(appPath, "Info.plist");

    try {
      return await readKeyFromPlist(plistPath, "CFBundleIdentifier");
    } catch (error) {
      throw new Error(
        `Failed to extract bundle ID from ${plistPath}: ${error}`,
      );
    }
  }

  /**
   * Gets simulator information
   * @returns Simulator device information
   */
  getDevice(): Device {
    return this.device;
  }

  /**
   * Checks if simulator is available for operations
   * @returns True if simulator is available
   */
  isSimulatorAvailable(): boolean {
    return this.device.state === "Booted" || this.device.state === "Shutdown";
  }

  /**
   * Resets the simulator to factory settings
   * @param options - Reset options
   *
   * @example
   * ```typescript
   * const runner = new SimulatorRunner(simulator);
   * await runner.resetSimulator();
   * ```
   */
  async resetSimulator(options: SimulatorRunnerOptions = {}): Promise<void> {
    const spinner = p.spinner();
    spinner.start(`Resetting simulator "${this.device.name}"`);

    try {
      await execa("xcrun", ["simctl", "erase", this.device.udid], {
        cwd: options.sourceDir,
      });
      spinner.stop(`Successfully reset simulator "${this.device.name}"`);
    } catch (error) {
      spinner.stop(`Failed to reset simulator "${this.device.name}"`);
      throw new Error(`Failed to reset simulator: ${error}`);
    }
  }
}

/**
 * Creates a new SimulatorRunner instance
 * @param device - Target simulator information
 * @returns New SimulatorRunner instance
 */
export const createSimulatorRunner = (device: Device): SimulatorRunner => {
  return new SimulatorRunner(device);
};
