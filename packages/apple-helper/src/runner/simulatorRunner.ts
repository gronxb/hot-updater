import { p } from "@hot-updater/cli-tools";
import { execa } from "execa";
import path from "path";
import type { AppleDevice } from "../types";

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
    // todo bring me the plist parser!!!!!!!!
    return await readKeyFromPlist(plistPath, "CFBundleIdentifier");
  } catch (error) {
    throw new Error(`Failed to extract bundle ID from ${plistPath}: ${error}`);
  }
};
