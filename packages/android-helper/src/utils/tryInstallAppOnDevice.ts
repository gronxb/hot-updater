// highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android

import * as p from "@clack/prompts";
import { type ExecaError, execa } from "execa";
import type { AndroidDevice } from "../types";
import { Device } from "./device";

export const tryInstallAppOnDevice = async ({
  device,
  apkPath,
}: {
  device: AndroidDevice;
  apkPath: string;
}) => {
  if (!device.deviceId) {
    p.log.warn(
      `No device with id "${device.deviceId}", skipping launching the app.`,
    );
    return;
  }

  const deviceId = device.deviceId;

  const adbArgs = ["-s", deviceId, "install", "-r", "-d"];

  adbArgs.push(apkPath);

  const adbPath = Device.getAdbPath();
  const loader = p.spinner();
  loader.start(
    `Installing the app on ${device.readableName} (id: ${deviceId})`,
  );
  try {
    await execa(adbPath, adbArgs);
    loader.stop(
      `Installed the app on ${device.readableName} (id: ${deviceId}).`,
    );
  } catch (error) {
    const errorMessage =
      (error as ExecaError).stdout ||
      (error as ExecaError).stderr ||
      "Unknown error";
    if (
      typeof errorMessage === "string" &&
      errorMessage.includes("INSTALL_FAILED_INSUFFICIENT_STORAGE")
    ) {
      loader.message("Installation failed due to insufficient storage");
    }
    loader.stop(
      `Failed: Installing the app on ${device.readableName} (id: ${deviceId})`,
      1,
    );
    throw new Error(
      typeof errorMessage === "string" ? errorMessage : "Installation failed",
    );
  }
};
