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

  if (schemeConfig.aab) {
    p.log.error("aab scheme can't not be build");
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

    if (device.deviceId) {
      const task = `assemble${schemeConfig.variant}`;
      const result = await runGradle({
        args: { extraParams: [`-PMIN_BUNDLE_ID=${bundleId}`] },
        appModuleName: schemeConfig.appModuleName,
        tasks: [task],
        androidProjectPath,
      });
      await runOnDevice({
        device,
        apkPath: result.buildArtifactPath,
        // tasks: [],
      });
      p.outro("Success 🎉");
      return result;
    }
  } else {
    // No specific device selected
    const connectedDevices = await Adb.getConnectedDevices();
    if (connectedDevices.length === 0) {
      p.log.info("No devices found. Launching first available emulator.");
      await Emulator.tryLaunchEmulator();
    }

    const task = `install${schemeConfig.variant}`;
    const result = await runGradle({
      args: { extraParams: [`-PMIN_BUNDLE_ID=${bundleId}`] },
      appModuleName: schemeConfig.appModuleName,
      tasks: [task],
      androidProjectPath,
    });

    // Run on all available devices
    const allDevices = await listAndroidDevices();
    for (const device of allDevices.filter((d) => d.connected)) {
      await runOnDevice({
        device,
        apkPath: result.buildArtifactPath,
        // tasks: [],
      });
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
