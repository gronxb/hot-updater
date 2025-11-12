import { p } from "@hot-updater/cli-tools";
import { execa } from "execa";
import type { AppleDevice } from "../types";

export interface SimulatorRunnerOptions {
  bundleIdentifier: string;
  infoPlistPath?: string;
  launch?: boolean;
  sourceDir?: string;
}

export const installAndLaunchOnSimulator = async ({
  device,
  appPath,
  options,
}: {
  device: AppleDevice;
  appPath: string;
  options: SimulatorRunnerOptions;
}) => {
  await launchSimulator({ device: device });
  await installOnSimulator({
    device: device,
    appPath: appPath,
    options: options,
  });

  if (options.launch !== false) {
    await launchAppOnSimulator({ device: device, options: options });
  }
};

export const launchSimulator = async ({ device }: { device: AppleDevice }) => {
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
    await bootSimulator({ device: device });
  }
};

export const installOnSimulator = async ({
  device,
  appPath,
  options,
}: {
  device: AppleDevice;
  appPath: string;
  options: SimulatorRunnerOptions;
}) => {
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

export const launchAppOnSimulator = async ({
  device,
  options,
}: {
  device: AppleDevice;
  options: SimulatorRunnerOptions;
}) => {
  const spinner = p.spinner();
  spinner.start(`Launching app on "${device.name}"`);

  try {
    await execa(
      "xcrun",
      ["simctl", "launch", device.udid, options.bundleIdentifier],
      {
        cwd: options.sourceDir,
      },
    );
    spinner.stop(`Successfully launched app on "${device.name}"`);
  } catch (error) {
    spinner.stop(`Failed to launch app on "${device.name}"`);
    throw new Error(`Failed to launch the app on simulator: ${error}`);
  }
};

const bootSimulator = async ({ device }: { device: AppleDevice }) => {
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
