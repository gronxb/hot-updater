// highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android

import { Adb, AndroidDeviceData } from './adb';
import { Emulator } from './emulator';

/**
 * List all Android devices and emulators (connected and available)
 */
export async function listAndroidDevices() {
  const devices = await Adb.getDevices();

  let allDevices: Array<AndroidDeviceData> = [];

  for (const deviceId of devices) {
    if (deviceId.includes('emulator')) {
      const emulatorData: AndroidDeviceData = {
        deviceId,
        readableName: await Adb.getEmulatorName(deviceId),
        connected: true,
        type: 'emulator',
      };
      allDevices = [...allDevices, emulatorData];
    } else {
      const phoneData: AndroidDeviceData = {
        deviceId,
        readableName: await Adb.getPhoneName(deviceId),
        type: 'phone',
        connected: true,
      };
      allDevices = [...allDevices, phoneData];
    }
  }

  const emulators = await Emulator.getEmulators();

  // Find not booted ones:
  emulators.forEach((emulatorName) => {
    // skip those already booted
    if (allDevices.some((device) => device.readableName === emulatorName)) {
      return;
    }
    const emulatorData: AndroidDeviceData = {
      deviceId: undefined,
      readableName: emulatorName,
      type: 'emulator',
      connected: false,
    };
    allDevices = [...allDevices, emulatorData];
  });

  return allDevices;
}
