import { p } from "@hot-updater/cli-tools";
import {
  generateMinBundleId,
  getCwd,
  type NativeBuildAndroidScheme,
} from "@hot-updater/plugin-core";
import path from "path";
import { tryInstallAppOnDevice } from "./runner/tryInstallAppOnDevice";
import { tryLaunchAppOnDevice } from "./runner/tryLaunchAppOnDevice";
import type { AndroidNativeRunOptions } from "./types";
import { Device } from "./utils/device";
import { enrichNativeBuildAndroidScheme } from "./utils/enrichNativeBuildAndroidScheme";
import { runGradle } from "./utils/gradle";

export const runAndroid = async ({
  schemeConfig: _schemeConfig,
  runOption,
}: {
  schemeConfig: NativeBuildAndroidScheme;
  runOption: AndroidNativeRunOptions;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const { interactive, device: deviceOption } = runOption;

  const androidProjectPath = path.join(getCwd(), "android");

  const schemeConfig = await enrichNativeBuildAndroidScheme({
    schemeConfig: _schemeConfig,
  });

  if (schemeConfig.aab) {
    p.log.error("aab scheme can't not be run");
    process.exit(1);
  }

  const device = await Device.selectTargetDevice({ deviceOption, interactive });

  if (device) {
    // Check if device is available, launch emulator if needed
    if (!(await Device.getConnectedDevices()).includes(device.deviceId || "")) {
      if (device.type === "emulator") {
        device.deviceId = await Device.tryLaunchEmulator(device.readableName);
      }
    }

    if (!device.deviceId) {
      throw new Error("Failed to run on any device");
    }
  } else {
    // No specific device selected
    const connectedDevices = await Device.getConnectedDevices();
    if (connectedDevices.length === 0) {
      p.log.info("No devices found. Launching first available emulator.");
      await Device.tryLaunchEmulator();
    }
  }

  const task = `assemble${schemeConfig.variant}`;

  const result = await runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${generateMinBundleId()}`] },
    appModuleName: schemeConfig.appModuleName,
    tasks: [task],
    androidProjectPath,
  });

  // Install and launch on target devices
  const targetDevices = device
    ? [device]
    : (await Device.listDevices()).filter((d) => d.connected);

  for (const targetDevice of targetDevices) {
    await tryInstallAppOnDevice({
      apkPath: result.buildArtifactPath,
      device: targetDevice,
    });
    await tryLaunchAppOnDevice({
      applicationId: schemeConfig.applicationId,
      device: targetDevice,
      mainActivity: runOption.mainActivity,
      packageName: schemeConfig.packageName,
      port: runOption.port,
    });
  }

  p.outro("Success 🎉");
  return result;
};
