import * as p from "@clack/prompts";
import { execa } from "execa";
import type { AndroidDevice } from "../types";
import { Adb } from "./adb";

export async function tryLaunchAppOnDevice({
  device,
  port,
  mainActivity,
  applicationId,
  packageName,
}: {
  device: AndroidDevice;
  port?: string;
  mainActivity?: string;
  applicationId: string;
  packageName: string;
}) {
  if (!device.deviceId) {
    p.log.warn(
      `No device with id "${device.deviceId}", skipping launching the app.`,
    );
    return;
  }

  const deviceId = device.deviceId;
  await Adb.tryRunAdbReverse({ deviceId, port });

  const activity = mainActivity || ".MainActivity";

  const activityToLaunch =
    activity.startsWith(packageName) ||
    (!activity.startsWith(".") && activity.includes("."))
      ? activity
      : activity.startsWith(".")
        ? [packageName, activity].join("")
        : [packageName, activity].filter(Boolean).join(".");

  const adbArgs = [
    "shell",
    "am",
    "start",
    "-n",
    `${applicationId}/${activityToLaunch}`,
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
      `Launched the app on ${device.readableName} (id: ${deviceId}) and listening on port ${port}.`,
    );
  } catch (error) {
    loader.stop("Failed to launch the app.", 1);
    throw new Error(`Failed to launch the app on ${device.readableName}`);
    // Original cause: (error as ExecaError).stderr
  }
}
