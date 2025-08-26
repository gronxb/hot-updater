import path from "path";
import * as p from "@clack/prompts";
import {
  type NativeBuildAndroidScheme,
  generateMinBundleId,
  getCwd,
} from "@hot-updater/plugin-core";
import type { AndroidDevice } from "./types";
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
  deviceOption,
  interactive,
}: {
  schemeConfig: NativeBuildAndroidScheme;
  deviceOption?: string | boolean;
  interactive: boolean;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const androidProjectPath = path.join(getCwd(), "android");
  const bundleId = generateMinBundleId();

  const schemeConfig = await enrichNativeBuildAndroidScheme({
    schemeConfig: _schemeConfig,
  });

  const device = (
    await selectAndroidTargetDevice({ deviceOption, interactive })
  ).device;

  const mainTaskType = device ? "assemble" : "install";
  const tasks = schemeConfig.aab
    ? [`bundle${schemeConfig.variant}`]
    : [`${mainTaskType}${schemeConfig.variant}`];

  if (device) {
    // Check if device is available, launch emulator if needed
    if (!(await Adb.getDevices()).includes(device.deviceId || "")) {
      if (device.type === "emulator") {
        p.log.info(`Launching emulator: ${device.readableName}`);
        device.deviceId = await Emulator.tryLaunchEmulator(device.readableName);
      }
    }

    if (device.deviceId) {
      const result = await runGradle({
        args: { extraParams: [`-PMIN_BUNDLE_ID=${bundleId}`] },
        appModuleName: schemeConfig.appModuleName,
        tasks,
        androidProjectPath,
      });
      await runOnDevice(device, schemeConfig);
      p.outro("Success 🎉");
      return result;
    }
  } else {
    // No specific device selected
    const connectedDevices = await Adb.getDevices();
    if (connectedDevices.length === 0) {
      if (interactive) {
        await selectAndLaunchDevice();
      } else {
        p.log.info("No devices found. Launching first available emulator.");
        await tryLaunchEmulator();
      }
    }

    const result = await runGradle({
      args: { extraParams: [`-PMIN_BUNDLE_ID=${bundleId}`] },
      appModuleName: schemeConfig.appModuleName,
      tasks,
      androidProjectPath,
    });

    // Run on all available devices
    const allDevices = await listAndroidDevices();
    for (const device of allDevices.filter((d) => d.connected)) {
      // await runOnDevice(device, schemeConfig);
    }

    return result;
  }

  throw new Error("Failed to run on any device");
};

async function runOnDevice({
  device,
  tasks,
  apkPath,
}: {
  device: AndroidDevice;
  tasks: string[];
  apkPath: string;
}) {
  const loader = p.spinner();
  loader.start("Installing the app");
  await tryInstallAppOnDevice({ apkPath, device });
  loader.message("Launching the app");
  const { applicationIdWithSuffix } = await tryLaunchAppOnDevice({
    device: {
      connected,
      deviceId,
      readableName,
      type,
    },
  });
  if (applicationIdWithSuffix) {
    loader.stop(
      `Installed and launched the app on ${color.bold(device.readableName)}`,
    );
  } else {
    loader.stop(
      `Failed: installing and launching the app on ${color.bold(
        device.readableName,
      )}`,
    );
  }
}
