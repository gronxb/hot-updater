import * as p from "@clack/prompts";
import { execa } from "execa";
import path from "path";
import type { AppleDevice } from "../utils/deviceManager";
import { readKeyFromPlist } from "../utils/plistManager";

export interface SimulatorRunnerOptions {
  sourceDir?: string;
  launch?: boolean;
  bundleId?: string;
  infoPlistPath?: string;
}

export const installAndLaunchOnSimulator = async (
  device: AppleDevice,
  appPath: string,
  options: SimulatorRunnerOptions = {},
) => {
  if (device.type !== "simulator") {
    throw new Error("Device must be a simulator");
  }

  await launchSimulator(device);
  await installOnSimulator(device, appPath, options);

  if (options.launch !== false) {
    const bundleId =
      options.bundleId ||
      (await extractBundleId(appPath, options.infoPlistPath));
    await launchAppOnSimulator(device, bundleId, options);
  }
};

export const launchSimulator = async (device: AppleDevice) => {
  if (device.type !== "simulator") {
    return;
  }

  // Launch Simulator.app with the correct device
  const { stdout: activeDeveloperDir } = await execa("xcode-select", ["-p"]);

  await execa("open", [
    `${activeDeveloperDir}/Applications/Simulator.app`,
    "--args",
    "-CurrentDeviceUDID",
    device.udid,
  ]);

  if (device.state !== "Booted") {
    await bootSimulator(device);
  }
};

export const installOnSimulator = async (
  device: AppleDevice,
  appPath: string,
  options: SimulatorRunnerOptions = {},
) => {
  const spinner = p.spinner();
  spinner.start(`Installing app on "${device.name}"`);

  try {
    await execa("xcrun", ["simctl", "install", device.udid, appPath], {
      cwd: options.sourceDir,
    });
    spinner.stop(`Successfully installed app on "${device.name}"`);
  } catch (error) {
    spinner.stop(`Failed to install app on "${device.name}"`);
    throw new Error(`Failed to install the app on simulator: ${error}`);
  }
};

export const launchAppOnSimulator = async (
  device: AppleDevice,
  bundleId: string,
  options: SimulatorRunnerOptions = {},
) => {
  const spinner = p.spinner();
  spinner.start(`Launching app on "${device.name}"`);

  try {
    await execa("xcrun", ["simctl", "launch", device.udid, bundleId], {
      cwd: options.sourceDir,
    });
    spinner.stop(`Successfully launched app on "${device.name}"`);
  } catch (error) {
    spinner.stop(`Failed to launch app on "${device.name}"`);
    throw new Error(`Failed to launch the app on simulator: ${error}`);
  }
};

export const uninstallFromSimulator = async (
  device: AppleDevice,
  bundleId: string,
  options: SimulatorRunnerOptions = {},
) => {
  const spinner = p.spinner();
  spinner.start(`Uninstalling app from "${device.name}"`);

  try {
    await execa("xcrun", ["simctl", "uninstall", device.udid, bundleId], {
      cwd: options.sourceDir,
    });
    spinner.stop(`Successfully uninstalled app from "${device.name}"`);
  } catch (error) {
    spinner.stop(`Failed to uninstall app from "${device.name}"`);
    throw new Error(`Failed to uninstall the app from simulator: ${error}`);
  }
};

export const resetSimulator = async (
  device: AppleDevice,
  options: SimulatorRunnerOptions = {},
) => {
  const spinner = p.spinner();
  spinner.start(`Resetting simulator "${device.name}"`);

  try {
    await execa("xcrun", ["simctl", "erase", device.udid], {
      cwd: options.sourceDir,
    });
    spinner.stop(`Successfully reset simulator "${device.name}"`);
  } catch (error) {
    spinner.stop(`Failed to reset simulator "${device.name}"`);
    throw new Error(`Failed to reset simulator: ${error}`);
  }
};

const bootSimulator = async (device: AppleDevice) => {
  try {
    await execa("xcrun", ["simctl", "boot", device.udid]);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes("Unable to boot device in current state: Booted")
    ) {
      p.log.info(`Simulator ${device.udid} already booted. Skipping.`);
      return;
    }
    throw new Error(`Failed to boot simulator: ${error}`);
  }
};

const extractBundleId = async (appPath: string, infoPlistPath?: string) => {
  const plistPath = infoPlistPath || path.join(appPath, "Info.plist");

  try {
    return await readKeyFromPlist(plistPath, "CFBundleIdentifier");
  } catch (error) {
    throw new Error(`Failed to extract bundle ID from ${plistPath}: ${error}`);
  }
};
