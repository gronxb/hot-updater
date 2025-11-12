import { p } from "@hot-updater/cli-tools";
import { execa } from "execa";

import type { AppleDevice } from "../types";

export interface DeviceRunnerOptions {
  sourceDir?: string;
  launch?: boolean;
  bundleIdentifier: string;
}

export const installAndLaunchOnDevice = async ({
  device,
  appPath,
  options,
}: {
  device: AppleDevice;
  appPath: string;
  options: DeviceRunnerOptions;
}) => {
  await installOnDevice({ device: device, appPath: appPath, options: options });

  if (options.launch !== false) {
    await launchAppOnDevice({
      device,
      options,
    });
  }
};

export const installOnDevice = async ({
  device,
  appPath,
  options,
}: {
  device: AppleDevice;
  appPath: string;
  options: DeviceRunnerOptions;
}) => {
  const deviceCtlArgs = [
    "devicectl",
    "device",
    "install",
    "app",
    "--device",
    device.udid,
    appPath,
  ];

  const spinner = p.spinner();
  spinner.start(`Installing app on ${device.name}`);

  try {
    await execa("xcrun", deviceCtlArgs, {
      cwd: options.sourceDir,
    });
    spinner.stop(`Successfully installed app on ${device.name}`);
  } catch (error) {
    spinner.stop(`Failed to install app on ${device.name}`);
    throw new Error(`Failed to install the app on ${device.name}: ${error}`);
  }
};

export const launchAppOnDevice = async ({
  device,
  options,
}: {
  device: AppleDevice;
  options: DeviceRunnerOptions;
}) => {
  const deviceCtlArgs = [
    "devicectl",
    "device",
    "process",
    "launch",
    "--device",
    device.udid,
    options.bundleIdentifier,
  ];

  const spinner = p.spinner();
  spinner.start(`Launching app on ${device.name}`);

  try {
    await execa("xcrun", deviceCtlArgs, {
      cwd: options.sourceDir,
    });
    spinner.stop(`Successfully launched app on ${device.name}`);
  } catch (error) {
    spinner.stop(`Failed to launch app on ${device.name}`);
    throw new Error(`Failed to launch the app on ${device.name}: ${error}`);
  }
};
