// highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android

import os from 'node:os';
import { Adb, AndroidDeviceData } from './adb';
import { execa } from 'execa';
import { Emulator } from './emulator';

/**
 * Get name of Android emulator
 */
async function getEmulatorName(deviceId: string): Promise<string> {
  const adbPath = Adb.getAdbPath();
  const { stdout } = await execa(
    adbPath,
    ['-s', deviceId, 'emu', 'avd', 'name'],
    { stdio: 'pipe' }
  );
  if(!stdout) {
    return ""
  }

  // 1st line should get us emu name
  return stdout.split(os.EOL)[0]!.replace(/(\r\n|\n|\r)/gm, '').trim();
}

/**
 * Get Android device name in readable format
 */
async function getPhoneName(deviceId: string): Promise<string> {
  const adbPath = Adb.getAdbPath();
  const { stdout } = await execa(
    adbPath,
    ['-s', deviceId, 'shell', 'getprop', 'ro.product.model'],
    { stdio: 'pipe' }
  );
  return stdout.replace(/\[ro\.product\.model\]:\s*\[(.*)\]/, '$1').trim();
}

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
        readableName: await getEmulatorName(deviceId),
        connected: true,
        type: 'emulator',
      };
      allDevices = [...allDevices, emulatorData];
    } else {
      const phoneData: AndroidDeviceData = {
        deviceId,
        readableName: await getPhoneName(deviceId),
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
