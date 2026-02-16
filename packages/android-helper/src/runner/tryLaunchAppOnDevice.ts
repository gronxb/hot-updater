import { p } from "@hot-updater/cli-tools";
import { execa } from "execa";
import type { AndroidDevice } from "../types";
import { Device } from "../utils/device";

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
  await Device.tryRunAdbReverse({ deviceId, port });

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

  const adbPath = Device.getAdbPath();
  console.debug(`Running ${adbPath} ${adbArgs.join(" ")}.`);
  const spinner = p.spinner();
  spinner.start(
    `Launching the app on ${device.readableName} (id: ${deviceId})`,
  );
  try {
    await execa(adbPath, adbArgs);
    spinner.stop(
      `Launched the app on ${device.readableName} (id: ${deviceId}) and listening on port ${port}.`,
    );
  } catch (_error) {
    spinner.error("Failed to launch the app.");
    throw new Error(`Failed to launch the app on ${device.readableName}`);
    // Original cause: (error as ExecaError).stderr
  }
}
