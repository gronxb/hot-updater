import * as p from "@clack/prompts";
import type {
  NativeBuildAndroidScheme,
  RequiredDeep,
} from "@hot-updater/plugin-core";
import { execa } from "execa";
import { Adb } from "./utils/adb";

export const installAndLaunchAndroid = async ({
  schemeConfig,
  buildArtifactPath,
}: {
  schemeConfig: RequiredDeep<NativeBuildAndroidScheme>;
  buildArtifactPath: string;
}) => {
  const devices = await Adb.getDevices();
  if (devices.length === 0) {
    p.log.error("No Android devices found.");
    return;
  }

  const device = await p.select({
    message: "Select a device to run the app on",
    options: devices.map((d) => ({ label: d, value: d })),
  });

  if (p.isCancel(device)) {
    return;
  }

  // if (!packageName) {
  //   p.log.error("No package name found in config");
  //   return;
  // }
  const { packageName } = schemeConfig;

  await execa("adb", ["-s", device, "install", "-r", buildArtifactPath]);
  await execa("adb", [
    "-s",
    device,
    "shell",
    "monkey",
    "-p",
    packageName,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);

  p.log.success(`Successfully launched ${packageName} on ${device}`);
};
