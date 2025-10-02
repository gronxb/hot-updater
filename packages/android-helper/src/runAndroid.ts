import path from "path";
import * as p from "@clack/prompts";
import {
  type NativeBuildAndroidScheme,
  generateMinBundleId,
  getCwd,
} from "@hot-updater/plugin-core";
import type { AndroidNativeRunOptions } from "./types";
import { Adb } from "./utils/adb";
import { Emulator } from "./utils/emulator";
import { enrichNativeBuildAndroidScheme } from "./utils/enrichNativeBuildAndroidScheme";
import { runGradle } from "./utils/gradle";
import {
  listAndroidDevices,
  selectAndroidTargetDevice,
} from "./utils/selectAndroidTargetDevice";
import { tryInstallAppOnDevice } from "./utils/tryInstallAppOnDevice";
import { tryLaunchAppOnDevice } from "./utils/tryLaunchAppOnDevice";

export const runAndroid = async ({
  schemeConfig: _schemeConfig,
  runOption,
}: {
  schemeConfig: NativeBuildAndroidScheme;
  runOption: AndroidNativeRunOptions;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const { interactive, device: deviceOption } = runOption;

  const androidProjectPath = path.join(getCwd(), "android");
  const bundleId = generateMinBundleId();

  const schemeConfig = await enrichNativeBuildAndroidScheme({
    schemeConfig: _schemeConfig,
  });

  if (schemeConfig.aab) {
    p.log.error("aab scheme can't not be run");
    process.exit(1);
  }

  const device = (
    await selectAndroidTargetDevice({ deviceOption, interactive })
  ).device;

  if (device) {
    // Check if device is available, launch emulator if needed
    if (!(await Adb.getConnectedDevices()).includes(device.deviceId || "")) {
      if (device.type === "emulator") {
        p.log.info(`Launching emulator: ${device.readableName}`);
        device.deviceId = await Emulator.tryLaunchEmulator(device.readableName);
      }
    }

    if (!device.deviceId) {
      throw new Error("Failed to run on any device");
    }
  } else {
    // No specific device selected
    const connectedDevices = await Adb.getConnectedDevices();
    if (connectedDevices.length === 0) {
      p.log.info("No devices found. Launching first available emulator.");
      await Emulator.tryLaunchEmulator();
    }
  }

  const task = device
    ? `assemble${schemeConfig.variant}`
    : `install${schemeConfig.variant}`;

  const result = await runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${bundleId}`] },
    appModuleName: schemeConfig.appModuleName,
    tasks: [task],
    androidProjectPath,
  });

  // Install and launch on target devices
  const targetDevices = device
    ? [device]
    : (await listAndroidDevices()).filter((d) => d.connected);

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
