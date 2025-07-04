import path from "node:path";
import { execa } from "execa";

export function getAdbPath() {
  return process.env["ANDROID_HOME"]
    ? path.join(process.env["ANDROID_HOME"], "platform-tools", "adb")
    : "adb";
}

/**
 * Parses the output of the 'adb devices' command
 */
function parseDevicesResult(result: string): Array<string> {
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
}

/**
 * Executes the commands needed to get a list of devices from ADB
 */
export async function getDevices() {
  const adbPath = getAdbPath();
  try {
    const { stdout } = await execa(adbPath, ["devices"], { stdio: "pipe" });
    return parseDevicesResult(stdout);
  } catch {
    return [];
  }
}
