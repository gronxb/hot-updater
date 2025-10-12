import * as p from "@clack/prompts";
import { getCwd, type NativeBuildIosScheme } from "@hot-updater/plugin-core";
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
import { enrichNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";
import { selectIosTargetDevice } from "./utils/selectIosTargetDevice";

export const runIos = async ({
  schemeConfig: _schemeConfig,
  runOption,
}: {
  schemeConfig: NativeBuildIosScheme;
  runOption: IosNativeRunOptions;
}): Promise<{ appPath: string; infoPlistPath: string }> => {
  const { interactive, device: deviceOption } = runOption;

  const iosProjectPath = path.join(getCwd(), "ios");

  const schemeConfig = await enrichNativeBuildIosScheme(_schemeConfig);

  const { device } = await selectIosTargetDevice({
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
      scheme: schemeConfig.scheme,
      configuration: schemeConfig.configuration,
      deviceType: selectedDevice.type,
      udid: selectedDevice.udid,
      installPods: schemeConfig.installPods,
      extraParams: schemeConfig.extraParams,
    });

    const runnerOptions: SimulatorRunnerOptions = {
      sourceDir: iosProjectPath,
      launch: true,
      infoPlistPath: result.infoPlistPath,
    };

    await installAndLaunchOnSimulator(
      selectedDevice,
      result.appPath,
      runnerOptions,
    );

    p.outro("Success 🎉");
    return result;
  }

  p.log.info(`Building for ${device.name}...`);

  const result = await buildXcodeProject({
    sourceDir: iosProjectPath,
    platform: schemeConfig.platform,
    scheme: schemeConfig.scheme,
    configuration: schemeConfig.configuration,
    deviceType: device.type,
    udid: device.udid,
    installPods: schemeConfig.installPods,
    extraParams: schemeConfig.extraParams,
  });

  const runnerOptions: DeviceRunnerOptions | SimulatorRunnerOptions = {
    sourceDir: iosProjectPath,
    launch: true,
  };

  if (device.type === "simulator") {
    await installAndLaunchOnSimulator(device, result.appPath, {
      ...runnerOptions,
      infoPlistPath: result.infoPlistPath,
    });
  } else {
    await installAndLaunchOnDevice(device, result.appPath, runnerOptions);
  }

  p.outro("Success 🎉");
  return result;
};
