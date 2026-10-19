import path from "path";

import {
  type CredentialResolver,
  createMinBundleId,
  getCwd,
  p,
} from "@hot-updater/cli-tools";

import { runGradle } from "./builder/runGradle";
import { tryInstallAppOnDevice } from "./runner/tryInstallAppOnDevice";
import { tryLaunchAppOnDevice } from "./runner/tryLaunchAppOnDevice";
import type { AndroidNativeRunOptions } from "./types";
import { Device } from "./utils/device";
import type { EnrichedNativeBuildAndroidScheme } from "./utils/enrichNativeBuildAndroidScheme";
import { resolveGradleSigningEnv } from "./utils/gradleSigning";

export const runAndroid = async ({
  schemeConfig,
  runOption,
  minBundleId = createMinBundleId("android"),
  credentials,
}: {
  schemeConfig: EnrichedNativeBuildAndroidScheme;
  runOption: AndroidNativeRunOptions;
  /** The MIN_BUNDLE_ID the build compiles in. */
  minBundleId?: string;
  /** Resolves the scheme's `signing` keystore, when it signs with one. */
  credentials?: Pick<CredentialResolver, "resolve">;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const { interactive, device: deviceOption } = runOption;

  const androidProjectPath = path.join(getCwd(), "android");

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
    args: { extraParams: [`-PMIN_BUNDLE_ID=${minBundleId}`] },
    env: await resolveGradleSigningEnv({ schemeConfig, credentials }),
    appModuleName: schemeConfig.appModuleName,
    logPrefix: `android-${schemeConfig.hotUpdaterSchemeName}-run`,
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
