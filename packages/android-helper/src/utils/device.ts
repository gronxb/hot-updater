import os from "node:os";
import * as p from "@clack/prompts";
import { spinner } from "@clack/prompts";
import { execa } from "execa";
import path from "path";
import type { AndroidDevice } from "../types";

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

  const devices: string[] = [];
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
    const { stdout } = await execa(adbPath, ["devices"]);
    return parseDevicesResult({ result: stdout });
  } catch {
    return [];
  }
};

/**
 * Runs ADB reverse tcp:8081 tcp:8081 to allow loading the jsbundle from the packager
 * Set up port forwarding from device to development server using adb reverse
 */
async function tryRunAdbReverse({
  port = 8081,
  deviceId,
}: {
  port?: number | string;
  deviceId: string;
}) {
  try {
    const adbPath = getAdbPath();
    const adbArgs = ["-s", deviceId, "reverse", `tcp:${port}`, `tcp:${port}`];

    p.log.info(`Connecting "${deviceId}" to the development server`);
    await execa(adbPath, adbArgs);
  } catch (_error) {
    throw new Error(
      `Failed to connect "${deviceId}" to development server using "adb reverse"`,
    );
  }
}

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

const emulatorCommand = process.env["ANDROID_HOME"]
  ? `${process.env["ANDROID_HOME"]}/emulator/emulator`
  : "emulator";

/**
 * Get a list of available Android emulators
 */
const getEmulatorNames = async () => {
  try {
    const { stdout } = await execa(emulatorCommand, ["-list-avds"], {
      stdio: "pipe",
    });
    // The `name` is AVD ID that is expected to not contain whitespace.
    // The `emulator` command, however, can occasionally return verbose
    // information about crashes or similar. Hence filtering out anything
    // that has basic whitespace.
    return stdout
      .split(os.EOL)
      .filter((name) => name !== "" && !name.includes(" "));
  } catch {
    return [];
  }
};

const checkEmulatorBootStatus = async ({
  port,
  emulatorName,
  loader,
  onBooted,
}: {
  port: number;
  emulatorName: string;
  loader: ReturnType<typeof spinner>;
  onBooted: (deviceId: string) => void;
}) => {
  const devices = await getConnectedDevices();
  const connected = devices.find((d) => d.includes(`${port}`));

  if (connected) {
    loader.message(`Emulator "${emulatorName}" is connected. Waiting for boot`);
    if (await isEmulatorBooted(connected)) {
      onBooted(connected);
    }
  }
};

/**
 * Launch the Android emulator and wait for it to boot
 */
const launchEmulator = async (
  emulatorName: string,
  port: number,
  loader: ReturnType<typeof spinner>,
): Promise<string> => {
  const manualCommand = `${emulatorCommand} -avd ${emulatorName}`;
  const timeout = 120;

  const cp = execa(
    emulatorCommand,
    ["-avd", emulatorName, "-port", `${port}`],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  cp.unref();

  return new Promise<string>((resolve, reject) => {
    let bootCheckInterval: NodeJS.Timeout;
    let rejectTimeout: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(rejectTimeout);
      clearInterval(bootCheckInterval);
    };

    const handleError = (message: string) => {
      cleanup();
      reject(new Error(message));
    };

    bootCheckInterval = setInterval(async () => {
      await checkEmulatorBootStatus({
        port,
        emulatorName,
        loader,
        onBooted: (deviceId) => {
          cleanup();
          resolve(deviceId);
        },
      });
    }, 1000);

    rejectTimeout = setTimeout(() => {
      handleError(
        `It took too long to start and connect with Android emulator: ${emulatorName}. You can try starting the emulator manually from the terminal with: ${manualCommand}`,
      );
    }, timeout * 1000);

    cp.catch((error) => {
      handleError(error);
    });
  });
};

const defaultPort = 5554;
const maxPort = 5682;

/**
 * Find an available port for emulator (starting from 5554)
 */
const getAvailableDevicePort = async (
  startPort: number = defaultPort,
): Promise<number> => {
  /**
   * The default value is 5554 for the first virtual device instance running on your machine.
   * A virtual device normally occupies a pair of adjacent ports: a console port and an adb port.
   * The console of the first virtual device running on a particular machine uses console port 5554 and adb port 5555.
   * Subsequent instances use port numbers increasing by two.
   * For example, 5556/5557, 5558/5559, and so on. The range is 5554 to 5682, allowing for 64 concurrent virtual devices.
   */
  const devices = await getConnectedDevices();

  for (let port = startPort; port <= maxPort; port += 2) {
    if (!devices.some((d) => d.includes(port.toString()))) {
      return port;
    }
  }

  throw new Error("Failed to launch emulator: no available ports");
};

/**
 * Try to launch an emulator (or find the first available one)
 */
const tryLaunchEmulator = async (name?: string) => {
  const port = await getAvailableDevicePort();
  const loader = spinner();
  loader.start("Looking for available emulators");

  const emulators = await getEmulatorNames();
  const emulatorName = name ?? emulators[0];

  let deviceId: string | undefined;
  if (emulators.length > 0) {
    try {
      loader.message(`Launching emulator "${emulatorName}"`);
      deviceId = await launchEmulator(emulatorName, port, loader);
      loader.stop(`Launched ${emulatorName} emulator.`);
    } catch (error) {
      loader.stop(
        `Failed to launch ${emulatorName} emulator. ${(error as Error).message}`,
        1,
      );
    }
  } else {
    loader.stop(
      "No emulators found as an output of `emulator -list-avds`. Please launch an emulator manually or connect a device",
      1,
    );
  }
  return deviceId;
};

/**
 * List all Android devices and emulators (connected and available)
 */
const listDevices = async (): Promise<AndroidDevice[]> => {
  const devices = await getConnectedDevices();

  const allDevices: Array<AndroidDevice> = [];

  for (const deviceId of devices) {
    if (deviceId.includes("emulator")) {
      const emulatorData: AndroidDevice = {
        deviceId,
        readableName: await getEmulatorName(deviceId),
        connected: true,
        type: "emulator",
      };
      allDevices.push(emulatorData);
    } else {
      const phoneData: AndroidDevice = {
        deviceId,
        readableName: await getPhoneName(deviceId),
        type: "phone",
        connected: true,
      };
      allDevices.push(phoneData);
    }
  }

  const emulatorNames = await getEmulatorNames();

  for (const emulatorName of emulatorNames) {
    if (allDevices.some((device) => device.readableName === emulatorName)) {
      continue;
    }
    const emulatorData: AndroidDevice = {
      deviceId: undefined,
      readableName: emulatorName,
      type: "emulator",
      connected: false,
    };
    allDevices.push(emulatorData);
  }

  return allDevices;
};

const matchingDevice = (devices: Array<AndroidDevice>, deviceArg: string) => {
  const deviceByName = devices.find(
    (device) => device.readableName === deviceArg,
  );
  const deviceById = devices.find((d) => d.deviceId === deviceArg);
  return deviceByName || deviceById;
};

const selectTargetDevice = async ({
  interactive,
  deviceOption,
}: {
  deviceOption?: string | boolean;
  interactive: boolean;
}): Promise<AndroidDevice | undefined> => {
  const availableDevices = await listDevices();

  if (deviceOption === true && !interactive) {
    p.log.error(
      "you can't select device manually with non-interactive cli mode(without -i option).",
    );
    process.exit(1);
  }

  if (typeof deviceOption === "string") {
    const matchedDevice = matchingDevice(availableDevices, deviceOption);
    if (!matchedDevice) {
      p.log.error(
        `device '${deviceOption}' isn't included in the attached devices.`,
      );
      process.exit(1);
    }
    return matchedDevice;
  }

  if (interactive) {
    if (!availableDevices.length) {
      p.log.error("you passed -d option but there is no attached adb devices.");
      process.exit(1);
    }
    const device = await p.select({
      message: "Target Device",
      options: availableDevices.map((d) => ({
        value: d,
        label: d.readableName,
      })),
    });
    if (p.isCancel(device)) {
      process.exit(1);
    }
    return device;
  }
  return undefined;
};

export const Device = {
  getAdbPath,
  getConnectedDevices,
  tryRunAdbReverse,
  tryLaunchEmulator,
  listDevices,
  selectTargetDevice,
};
