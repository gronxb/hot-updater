// highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android

import os from "node:os";
import { spinner } from "@clack/prompts";
import { execa } from "execa";
import { Adb } from "./adb";

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

/**
 * Launch the Android emulator and wait for it to boot
 */
const launchEmulator = async (
  emulatorName: string,
  port: number,
  loader: ReturnType<typeof spinner>,
): Promise<string> => {
  const manualCommand = `${emulatorCommand} @${emulatorName}`;

  const cp = execa(emulatorCommand, [`@${emulatorName}`, "-port", `${port}`], {
    detached: true,
    stdio: "ignore",
  });
  cp.unref();
  const timeout = 120;

  return new Promise<string>((resolve, reject) => {
    const bootCheckInterval = setInterval(async () => {
      const devices = await Adb.getConnectedDevices();
      const connected = port
        ? devices.find((d) => d.includes(`${port}`))
        : false;

      if (connected) {
        loader.message(
          `Emulator "${emulatorName}" is connected. Waiting for boot`,
        );
        if (await Adb.isEmulatorBooted(connected)) {
          cleanup();
          resolve(connected);
        }
      }
    }, 1000);
    // Reject command after timeout
    const rejectTimeout = setTimeout(() => {
      stopWaitingAndReject(
        `It took too long to start and connect with Android emulator: ${emulatorName}. You can try starting the emulator manually from the terminal with: ${manualCommand}`,
      );
    }, timeout * 1000);

    const cleanup = () => {
      clearTimeout(rejectTimeout);
      clearInterval(bootCheckInterval);
    };

    const stopWaitingAndReject = (message: string) => {
      cleanup();
      reject(new Error(message));
    };

    cp.catch((error) => {
      stopWaitingAndReject(error);
    });
  });
};

const defaultPort = 5554;
/**
 * Find an available port for emulator (starting from 5552)
 */
const getAvailableDevicePort = async (
  port: number = defaultPort,
): Promise<number> => {
  /**
   * The default value is 5554 for the first virtual device instance running on your machine.
   * A virtual device normally occupies a pair of adjacent ports: a console port and an adb port.
   * The console of the first virtual device running on a particular machine uses console port 5554 and adb port 5555. Subsequent instances use port numbers increasing by two. For example, 5556/5557, 5558/5559, and so on. The range is 5554 to 5682, allowing for 64 concurrent virtual devices.
   */
  const devices = await Adb.getConnectedDevices();
  if (port > 5682) {
    throw new Error("Failed to launch emulator");
  }
  if (devices.some((d) => d.includes(port.toString()))) {
    return await getAvailableDevicePort(port + 2);
  }
  return port;
};

/**
 * Try to launch an emulator (or find the first available one)
 */
const tryLaunchEmulator = async (name?: string) => {
  const port = await getAvailableDevicePort();
  const loader = spinner();
  loader.start(`Looking for available emulators"`);

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

export const Emulator = {
  getEmulatorNames,
  tryLaunchEmulator,
};
