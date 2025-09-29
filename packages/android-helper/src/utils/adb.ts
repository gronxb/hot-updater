import os from "node:os";
import path from "path";
import * as p from "@clack/prompts";
import { execa } from "execa";
import type { AndroidUser } from "../types";

/**
 * Get the path to adb executable from ANDROID_HOME or use system adb
 */
const getAdbPath = (): string => {
  return process.env["ANDROID_HOME"]
    ? path.join(process.env["ANDROID_HOME"], "platform-tools", "adb")
    : "adb";
};

/**
 * Parses the output of the 'adb devices' command
 */
const parseDevicesResult = ({ result }: { result: string }): string[] => {
  if (!result) {
    return [];
  }

  const devices = [];
  const lines = result.trim().split(/\r?\n/);

  for (const line of lines) {
    const [device, state] = line.split(/[ ,\t]+/).filter((w) => w !== "");

    if (device && state === "device") {
      devices.push(device);
    }
  }
  return devices;
};

/**
 * Executes the commands needed to get a list of devices from ADB
 */
// Get list of connected Android devices using adb
const getConnectedDevices = async (): Promise<string[]> => {
  const adbPath = getAdbPath();
  try {
    const { stdout } = await execa(adbPath, ["devices"], { stdio: "pipe" });
    return parseDevicesResult({ result: stdout });
  } catch {
    return [];
  }
};

/**
 * Runs ADB reverse tcp:8081 tcp:8081 to allow loading the jsbundle from the packager
 * Set up port forwarding from device to development server using adb reverse
 */
async function tryRunAdbReverse(packagerPort: number | string, device: string) {
  try {
    const adbPath = getAdbPath();
    const adbArgs = [
      "-s",
      device,
      "reverse",
      `tcp:${packagerPort}`,
      `tcp:${packagerPort}`,
    ];

    p.log.info(`Connecting "${device}" to the development server`);
    await execa(adbPath, adbArgs);
  } catch (error) {
    throw new Error(
      `Failed to connect "${device}" to development server using "adb reverse"`,
    );
    // Original cause: (error as ExecaError).stderr
  }
}

// Device information functions
/**
 * Get name of Android emulator
 */
const getEmulatorName = async (deviceId: string): Promise<string> => {
  const adbPath = getAdbPath();
  const { stdout } = await execa(
    adbPath,
    ["-s", deviceId, "emu", "avd", "name"],
    { stdio: "pipe" },
  );
  if (!stdout) {
    return "";
  }

  // 1st line should get us emu name
  return stdout
    .split(os.EOL)[0]!
    .replace(/(\r\n|\n|\r)/gm, "")
    .trim();
};

/**
 * Get Android device name in readable format
 */
const getPhoneName = async (deviceId: string): Promise<string> => {
  const adbPath = getAdbPath();
  const { stdout } = await execa(
    adbPath,
    ["-s", deviceId, "shell", "getprop", "ro.product.model"],
    { stdio: "pipe" },
  );
  return stdout.replace(/\[ro\.product\.model\]:\s*\[(.*)\]/, "$1").trim();
};

/**
 * Check if emulator has finished booting
 */
const isEmulatorBooted = async (device: string) => {
  const adbPath = getAdbPath();
  const adbArgs = ["-s", device, "shell", "getprop", "sys.boot_completed"];
  try {
    const { stdout } = await execa(adbPath, adbArgs, { stdio: "pipe" });
    return stdout.trim() === "1";
  } catch {
    return false;
  }
};

export const Adb = {
  getAdbPath,
  getConnectedDevices,
  tryRunAdbReverse,
  getEmulatorName,
  getPhoneName,
  isEmulatorBooted,
};

export type { AndroidUser as User };
