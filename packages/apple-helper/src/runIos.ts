import { getCwd, p } from "@hot-updater/cli-tools";
import path from "path";
import { buildXcodeProject } from "./builder/buildXcodeProject";
import {
  type DeviceRunnerOptions,
  installAndLaunchOnDevice,
} from "./runner/deviceRunner";
import {
  installAndLaunchOnSimulator,
  type SimulatorRunnerOptions,
} from "./runner/simulatorRunner";
import type { IosNativeRunOptions } from "./types";
import { Device } from "./utils/device";
import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";

export const runIos = async ({
  schemeConfig,
  runOption,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  runOption: IosNativeRunOptions;
}): Promise<{ appPath: string; infoPlistPath: string }> => {
  const { interactive, device: deviceOption } = runOption;

  const iosProjectPath = path.join(getCwd(), "ios");

  const device = await Device.selectTargetDevice({
    platform: "ios",
    deviceOption,
    interactive,
  });

  if (!device) {
    const simulators = await Device.listDevices("ios", {
      deviceType: "simulator",
    });

    if (simulators.length === 0) {
      p.log.error("No simulators found. Please create a simulator in Xcode.");
      process.exit(1);
    }

    p.log.info(`Using first available simulator: ${simulators[0].name}`);
    const selectedDevice = simulators[0];

    p.log.info(`Building for ${selectedDevice.name}...`);

    const result = await buildXcodeProject({
      sourceDir: iosProjectPath,
      platform: schemeConfig.platform,
      xcodeScheme: schemeConfig.scheme,
      configuration: schemeConfig.configuration,
      deviceType: selectedDevice.type,
      destination: [{ id: selectedDevice.udid }],
      installPods: schemeConfig.installPods,
      extraParams: schemeConfig.extraParams,
      logPrefix: `ios-${schemeConfig.hotUpdaterSchemeName}-run`,
    });

    const runnerOptions: SimulatorRunnerOptions = {
      bundleIdentifier: schemeConfig.bundleIdentifier,
      sourceDir: iosProjectPath,
      launch: true,
      infoPlistPath: result.infoPlistPath,
    };

    await installAndLaunchOnSimulator({
      device: selectedDevice,
      appPath: result.appPath,
      options: runnerOptions,
    });

    p.outro("Success 🎉");
    return result;
  }

  p.log.info(`Building for ${device.name}...`);

  const result = await buildXcodeProject({
    sourceDir: iosProjectPath,
    platform: schemeConfig.platform,
    xcodeScheme: schemeConfig.scheme,
    configuration: schemeConfig.configuration,
    deviceType: device.type,
    destination: [{ id: device.udid }],
    installPods: schemeConfig.installPods,
    extraParams: schemeConfig.extraParams,
    logPrefix: `ios-${schemeConfig.hotUpdaterSchemeName}-run`,
  });

  const runnerOptions: DeviceRunnerOptions | SimulatorRunnerOptions = {
    bundleIdentifier: schemeConfig.bundleIdentifier,
    sourceDir: iosProjectPath,
    launch: true,
  };

  if (device.type === "simulator") {
    await installAndLaunchOnSimulator({
      device: device,
      appPath: result.appPath,
      options: {
        ...runnerOptions,
        infoPlistPath: result.infoPlistPath,
      },
    });
  } else {
    await installAndLaunchOnDevice({
      device: device,
      appPath: result.appPath,
      options: runnerOptions,
    });
  }

  p.outro("Success 🎉");
  return result;
};
