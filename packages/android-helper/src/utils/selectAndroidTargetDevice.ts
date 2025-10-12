import * as p from "@clack/prompts";
import type { AndroidDevice } from "../types";
import { Adb } from "./adb";
import { Emulator } from "./emulator";

export const selectAndroidTargetDevice = async ({
  interactive,
  deviceOption,
}: {
  deviceOption?: string | boolean;
  interactive: boolean;
}): Promise<{ device?: AndroidDevice }> => {
  const availableDevices = await listAndroidDevices();

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
    return { device: matchedDevice };
  }

  if (interactive) {
    // if user want to select device manually but not available
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
    return { device };
  }
  return { device: undefined };
};

const matchingDevice = (devices: Array<AndroidDevice>, deviceArg: string) => {
  const deviceByName = devices.find(
    (device) => device.readableName === deviceArg,
  );
  const deviceById = devices.find((d) => d.deviceId === deviceArg);
  return deviceByName || deviceById;
};
/**
 * List all Android devices and emulators (connected and available)
 */
export const listAndroidDevices = async (): Promise<AndroidDevice[]> => {
  const devices = await Adb.getConnectedDevices();

  let allDevices: Array<AndroidDevice> = [];

  for (const deviceId of devices) {
    if (deviceId.includes("emulator")) {
      const emulatorData: AndroidDevice = {
        deviceId,
        readableName: await Adb.getEmulatorName(deviceId),
        connected: true,
        type: "emulator",
      };
      allDevices.push(emulatorData);
    } else {
      const phoneData: AndroidDevice = {
        deviceId,
        readableName: await Adb.getPhoneName(deviceId),
        type: "phone",
        connected: true,
      };
      allDevices.push(phoneData);
    }
  }

  const emulatorNames = await Emulator.getEmulatorNames();

  // Find not booted ones:
  for (const emulatorName of emulatorNames) {
    // skip those already booted
    if (allDevices.some((device) => device.readableName === emulatorName)) {
      continue;
    }
    const emulatorData: AndroidDevice = {
      deviceId: undefined,
      readableName: emulatorName,
      type: "emulator",
      connected: false,
    };
    allDevices = [...allDevices, emulatorData];
  }

  return allDevices;
};
