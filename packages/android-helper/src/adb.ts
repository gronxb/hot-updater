import path from "node:path";
import { execa, type ExecaError } from "execa";
import * as p from '@clack/prompts'

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
const getDevices = async (): Promise<string[]> => {
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
async function tryRunAdbReverse(
  packagerPort: number | string,
  device: string
) {
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
      `Failed to connect "${device}" to development server using "adb reverse"`
    );
    // Original cause: (error as ExecaError).stderr
  }
}

export type AndroidDeviceData = {
  deviceId: string | undefined;
  readableName: string;
  connected: boolean;
  type: 'emulator' | 'phone';
};

export const Adb = {
  getAdbPath,
  parseDevicesResult,
  getDevices,
  tryRunAdbReverse,
};

