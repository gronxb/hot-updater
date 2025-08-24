import type { AndroidDevice } from "../types";
// highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android
import { Adb } from "./adb";
import { Emulator } from "./emulator";

/**
 * List all Android devices and emulators (connected and available)
 */
export async function listAndroidDevices() {
  const devices = await Adb.getDevices();

  let allDevices: Array<AndroidDevice> = [];

  for (const deviceId of devices) {
    if (deviceId.includes("emulator")) {
      const emulatorData: AndroidDevice = {
        deviceId,
        readableName: await Adb.getEmulatorName(deviceId),
        connected: true,
        type: "emulator",
      };
      allDevices = [...allDevices, emulatorData];
    } else {
      const phoneData: AndroidDevice = {
        deviceId,
        readableName: await Adb.getPhoneName(deviceId),
        type: "phone",
        connected: true,
      };
      allDevices = [...allDevices, phoneData];
    }
  }

  const emulators = await Emulator.getEmulators();

  // Find not booted ones:
  for (const emulatorName of emulators) {
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
}
