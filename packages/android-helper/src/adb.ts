import path from "node:path";
import os from "node:os";
import * as p from "@clack/prompts";
import { select, spinner } from "@clack/prompts";
import { execa } from "execa";

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

export type AndroidDeviceData = {
  deviceId: string | undefined;
  readableName: string;
  connected: boolean;
  type: "emulator" | "phone";
};

// User management functions
type User = {
  id: string;
  name: string;
};

const userRegex = new RegExp(
  /^\s*UserInfo\{(?<userId>\d+):(?<userName>.*):(?<userFlags>[0-9a-f]*)}/,
);

/**
 * Check users on Android device
 */
const checkUsers = async (device: string): Promise<User[]> => {
  const adbPath = getAdbPath();
  const adbArgs = ["-s", device, "shell", "pm", "list", "users"];
  const loader = spinner();
  loader.start(`Checking users on "${device}"`);

  try {
    const { stdout, stderr } = await execa(adbPath, adbArgs, { stdio: "pipe" });

    if (stderr) {
      loader.stop(`Failed to check users of "${device}". ${stderr}`, 1);
      return [];
    }

    const lines = stdout.split("\n");
    const users = [];

    for (const line of lines) {
      const res = userRegex.exec(line);
      if (res?.groups?.userId && res?.groups?.userName) {
        users.push({ id: res.groups["userId"], name: res.groups["userName"] });
      }
    }

    loader.stop(`Found ${users.length} users on "${device}".`);
    return users as User[];
  } catch (error) {
    loader.stop(
      `Unexpected error while checking users of "${device}". Continuing without user selection. Error details: ${
        (error as { message: string }).message
      }.`,
      1,
    );
    return [];
  }
};

/**
 * Prompt user to select user profile for app installation
 */
const promptForUser = async (deviceId: string) => {
  const users = await checkUsers(deviceId);
  if (users.length > 1) {
    const selectedUser = await select({
      message: "Which user profile would you like to launch your app into?",
      options: users.map((user) => ({
        label: user.name,
        value: user,
      })),
    });

    return selectedUser;
  }

  return null;
};

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
  getDevices,
  tryRunAdbReverse,
  checkUsers,
  promptForUser,
  getEmulatorName,
  getPhoneName,
  isEmulatorBooted,
};

export type { User };
