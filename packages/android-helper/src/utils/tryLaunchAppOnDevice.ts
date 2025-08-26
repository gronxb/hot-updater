// highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android

import * as p from "@clack/prompts";
import { execa } from "execa";
import type { AndroidDevice } from "../types";
import { Adb } from "./adb";

/**
 * Try to launch app on Android device
 */
export async function tryLaunchAppOnDevice({
  device,
  androidProject,
  args,
}: { device: AndroidDevice; androidProject: any; args: {} }) {
  if (!device.deviceId) {
    p.log.warn(
      `No device with id "${device.deviceId}", skipping launching the app.`,
    );
    return;
  }

  const deviceId = device.deviceId;
  await Adb.tryRunAdbReverse(args.port, deviceId);

  const { appId, appIdSuffix } = args;
  const { packageName, mainActivity, applicationId } = androidProject;

  const applicationIdWithSuffix = [appId || applicationId, appIdSuffix]
    .filter(Boolean)
    .join(".");

  const activity = args.mainActivity ?? mainActivity;

  const activityToLaunch =
    activity.startsWith(packageName) ||
    (!activity.startsWith(".") && activity.includes("."))
      ? activity
      : activity.startsWith(".")
        ? [packageName, activity].join("")
        : [packageName, activity].filter(Boolean).join(".");

  // Here we're using the same flags as Android Studio to launch the app
  const adbArgs = [
    "shell",
    "am",
    "start",
    "-n",
    `${applicationIdWithSuffix}/${activityToLaunch}`,
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER",
  ];

  adbArgs.unshift("-s", deviceId);

  const adbPath = Adb.getAdbPath();
  console.debug(`Running ${adbPath} ${adbArgs.join(" ")}.`);
  const loader = p.spinner();
  loader.start(`Launching the app on ${device.readableName} (id: ${deviceId})`);
  try {
    await execa(adbPath, adbArgs);
    loader.stop(
      `Launched the app on ${device.readableName} (id: ${deviceId}) and listening on port ${args.port}.`,
    );
  } catch (error) {
    loader.stop("Failed to launch the app.", 1);
    throw new Error(`Failed to launch the app on ${device.readableName}`);
    // Original cause: (error as ExecaError).stderr
  }
}
