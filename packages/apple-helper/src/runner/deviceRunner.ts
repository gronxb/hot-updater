import * as p from "@clack/prompts";
import { execa } from "execa";
import type { AppleDevice } from "../utils/deviceManager";

export interface DeviceRunnerOptions {
  sourceDir?: string;
  launch?: boolean;
  bundleId?: string;
}

export const installAndLaunchOnDevice = async (
  device: AppleDevice,
  appPath: string,
  options: DeviceRunnerOptions = {},
) => {
  await installOnDevice(device, appPath, options);

  if (options.launch !== false) {
    await launchAppOnDevice(
      device,
      options.bundleId || (await extractBundleId(appPath)),
      options,
    );
  }
};

export const installOnDevice = async (
  device: AppleDevice,
  appPath: string,
  options: DeviceRunnerOptions = {},
) => {
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

export const launchAppOnDevice = async (
  device: AppleDevice,
  bundleId: string,
  options: DeviceRunnerOptions = {},
) => {
  const deviceCtlArgs = [
    "devicectl",
    "device",
    "process",
    "launch",
    "--device",
    device.udid,
    bundleId,
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

export const uninstallFromDevice = async (
  device: AppleDevice,
  bundleId: string,
  options: DeviceRunnerOptions = {},
) => {
  const deviceCtlArgs = [
    "devicectl",
    "device",
    "uninstall",
    "app",
    "--device",
    device.udid,
    bundleId,
  ];

  const spinner = p.spinner();
  spinner.start(`Uninstalling app from ${device.name}`);

  try {
    await execa("xcrun", deviceCtlArgs, {
      cwd: options.sourceDir,
    });
    spinner.stop(`Successfully uninstalled app from ${device.name}`);
  } catch (error) {
    spinner.stop(`Failed to uninstall app from ${device.name}`);
    throw new Error(
      `Failed to uninstall the app from ${device.name}: ${error}`,
    );
  }
};

const extractBundleId = async (appPath: string) => {
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
};
